use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit,
        State,
        Multipart,
    },
    http::{header, HeaderName, Method},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::stream::Stream;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    db_tx: tokio::sync::mpsc::Sender<DbCommand>,
    mcp_tx: tokio::sync::broadcast::Sender<String>,
    timeline_cache: Arc<std::sync::RwLock<String>>,
}

#[derive(Deserialize, Serialize, Debug)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    payload: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug)]
struct ProjectDbMetadata {
    id: String,
    name: String,
    duration: f64,
    thumbnail: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

enum DbCommand {
    SaveProject {
        project: serde_json::Value,
        resp: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    ApplyDelta {
        project_id: String,
        op: String,
        payload: serde_json::Value,
        resp: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    DeleteProject {
        id: String,
        resp: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}

#[tokio::main]
async fn main() {
    // 0. Load .env (no external dep) so provider API keys (GEMINI_API_KEY,
    //    OPENAI_API_KEY, XAI_API_KEY, ANTHROPIC_API_KEY) are available to the
    //    agent-step proxy without exporting them in the shell.
    load_dotenv();

    // 1. Create static storage directory inside workspace
    std::fs::create_dir_all("./shared_storage").ok();

    // 2. Initialize relational database and set WAL mode
    let conn = Connection::open("chronox.db").expect("Failed to open database");
    conn.execute("PRAGMA journal_mode=WAL;", ()).ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            duration REAL NOT NULL,
            thumbnail TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            data TEXT NOT NULL
        )",
        (),
    ).expect("Failed to create projects table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            track_type TEXT NOT NULL,
            is_main INTEGER,
            muted INTEGER,
            hidden INTEGER
        )",
        (),
    ).expect("Failed to create tracks table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS elements (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL,
            name TEXT NOT NULL,
            element_type TEXT NOT NULL,
            duration REAL NOT NULL,
            start_time REAL NOT NULL,
            trim_start REAL NOT NULL,
            trim_end REAL NOT NULL,
            source_duration REAL,
            source_original_path TEXT,
            source_proxy_path TEXT,
            data TEXT NOT NULL
        )",
        (),
    ).expect("Failed to create elements table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS keyframes (
            id TEXT PRIMARY KEY,
            element_id TEXT NOT NULL,
            property TEXT NOT NULL,
            time REAL NOT NULL,
            value REAL NOT NULL,
            interpolation TEXT NOT NULL
        )",
        (),
    ).expect("Failed to create keyframes table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS vad_segments (
            id TEXT PRIMARY KEY,
            element_id TEXT NOT NULL,
            start_local REAL NOT NULL,
            end_local REAL NOT NULL,
            confidence REAL NOT NULL
        )",
        (),
    ).expect("Failed to create vad_segments table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS scene_vectors (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL,
            scene_index INTEGER NOT NULL,
            start_time REAL NOT NULL,
            end_time REAL NOT NULL,
            vector BLOB NOT NULL,
            description TEXT
        )",
        (),
    ).expect("Failed to create scene_vectors table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS episodic_memory (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            searchable TEXT NOT NULL,
            situation TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT NOT NULL,
            confidence REAL NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL
        )",
        (),
    ).expect("Failed to create episodic_memory table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_gap_queue (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            description TEXT NOT NULL,
            frequency INTEGER NOT NULL,
            status TEXT NOT NULL
        )",
        (),
    ).expect("Failed to create knowledge_gap_queue table");

    // 3. Setup single-threaded MPSC SQLite actor loop
    let (db_tx, mut db_rx) = tokio::sync::mpsc::channel::<DbCommand>(200);
    let mut bg_conn = Connection::open("chronox.db").expect("Failed to open background database");
    bg_conn.execute("PRAGMA journal_mode=WAL;", ()).ok();

    tokio::spawn(async move {
        while let Some(cmd) = db_rx.recv().await {
            match cmd {
                DbCommand::SaveProject { project, resp } => {
                    let res = save_project_internal(&mut bg_conn, project);
                    let _ = resp.send(res);
                }
                DbCommand::ApplyDelta { project_id, op, payload, resp } => {
                    let res = apply_delta_internal(&mut bg_conn, &project_id, &op, payload);
                    let _ = resp.send(res);
                }
                DbCommand::DeleteProject { id, resp } => {
                    let res = delete_project_internal(&mut bg_conn, &id);
                    let _ = resp.send(res);
                }
            }
        }
    });

    let (mcp_tx, _) = tokio::sync::broadcast::channel::<String>(100);
    let timeline_cache = Arc::new(std::sync::RwLock::new("Empty timeline — no clips added.".to_string()));

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        db_tx,
        mcp_tx,
        timeline_cache,
    };

    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:3000".parse().unwrap(),
            "http://127.0.0.1:3000".parse().unwrap(),
            "http://localhost:3100".parse().unwrap(),
            "http://127.0.0.1:3100".parse().unwrap(),
        ])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::UPGRADE,
            header::CONNECTION,
            HeaderName::from_static("sec-websocket-key"),
            HeaderName::from_static("sec-websocket-version"),
            HeaderName::from_static("sec-websocket-extensions"),
        ]);

    let app = Router::new()
        .route("/ws", get(ws_handler_global))
        .route("/ws/:project_id", get(ws_handler_project))
        .route("/api/upload", post(upload_handler))
        .route("/api/ai/download-asset", post(download_asset_handler))
        .route("/api/webhook/vad", post(vad_webhook_handler))
        .route("/api/elements/:element_id/vad", get(get_element_vad))
        .route("/api/ai/reload-cache", post(ai_reload_cache_handler))
        .route("/api/ai/status", get(get_ai_status))
        .route("/api/ai/search", post(ai_vector_search_handler))
        .route("/api/ai/execute", post(execute_ai_task))
        .route("/api/ai/track", post(ai_track_handler))
        .route("/api/ai/chat", post(chat_handler))
        .route("/api/ai/extract-recipe", post(extract_recipe_handler))
        .route("/api/ai/apply-recipe", post(apply_recipe_handler))
        .route("/api/ai/synthesize-sources", post(synthesize_sources_handler))
        .route("/api/mcp/timeline", get(mcp_timeline_handler))
        .route("/api/mcp/execute", post(mcp_execute_handler))
        .route("/api/project/export", post(export_project_handler))
        .route("/api/ai/mimic-flow", post(ai_mimic_flow_handler))
        .route("/api/ai/scene-map", post(ai_scene_map_handler))
        .route("/api/ai/agent-step", post(agent_step_handler))
        .route("/api/ai/grade-scenes", post(grade_scenes_handler))
        .route("/api/ai/curate-scenes", post(curate_scenes_handler))
        .route("/api/notion/brief", post(notion_brief_handler))
        .route("/api/ai/provider-models", post(provider_models_handler))
        .route("/api/ai/transcribe", post(ai_transcribe_handler))
        .route("/api/ai/detect-beats", post(ai_detect_beats_handler))
        .route("/api/vision-tag", post(vision_tag_handler))
        .route("/api/ai/write-back", post(ai_write_back_handler))
        .route("/api/ai/query-episodic", post(ai_query_episodic_handler))
        .nest_service("/static", tower_http::services::ServeDir::new("./shared_storage"))
        // Media uploads can be hundreds of MB; lift axum's 2MB default cap.
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8000));
    println!("Starting ChronoX Backend on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ─── WebSocket Handlers ──────────────────────────────────────

async fn ws_handler_global(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn ws_handler_project(
    ws: WebSocketUpgrade,
    axum::extract::Path(_project_id): axum::extract::Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    println!("WebSocket upgrade successful!");

    let init_msg = serde_json::json!({
        "type": "CONNECTION_STATUS",
        "payload": {
            "status": "connected",
            "message": "Successfully connected to ChronoX Local Rust Server"
        }
    });

    if socket
        .send(Message::Text(init_msg.to_string()))
        .await
        .is_err()
    {
        println!("Failed to send init message");
        return;
    }

    let mut mcp_rx = state.mcp_tx.subscribe();

    loop {
        tokio::select! {
            val = socket.recv() => {
                match val {
                    Some(Ok(msg)) => {
                        if let Message::Text(text) = msg {
                            if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                                if ws_msg.msg_type == "UPDATE_TIMELINE_SNAPSHOT" {
                                    if let Some(snapshot) = ws_msg.payload.get("snapshot").and_then(|s| s.as_str()) {
                                        if let Ok(mut cache) = state.timeline_cache.write() {
                                            *cache = snapshot.to_string();
                                        }
                                    }
                                } else {
                                    let response = handle_command(ws_msg, &state).await;
                                    if let Some(resp_msg) = response {
                                        if socket.send(Message::Text(resp_msg)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => break,
                }
            }
            mcp_msg = mcp_rx.recv() => {
                if let Ok(msg_text) = mcp_msg {
                    if socket.send(Message::Text(msg_text)).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    println!("WebSocket connection closed");
}

async fn handle_command(msg: WsMessage, state: &AppState) -> Option<String> {
    println!("Handling WS command: {}", msg.msg_type);

    let response_payload = match msg.msg_type.as_str() {
        "HANDSHAKE" => {
            serde_json::json!({
                "type": "HANDSHAKE_ACK",
                "requestId": msg.request_id,
                "payload": { "server": "ChronoX Rust Backend", "version": "0.1.0" }
            })
        }
        "GET_PROJECTS" => {
            let db = state.db.lock().unwrap();
            let mut stmt = db
                .prepare("SELECT id, name, duration, thumbnail, created_at, updated_at FROM projects ORDER BY updated_at DESC")
                .ok()?;

            let projects_iter = stmt
                .query_map((), |row| {
                    Ok(ProjectDbMetadata {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        duration: row.get(2)?,
                        thumbnail: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .ok()?;

            let mut projects = Vec::new();
            for p in projects_iter {
                if let Ok(project) = p {
                    projects.push(project);
                }
            }

            serde_json::json!({
                "type": "PROJECTS_LIST",
                "requestId": msg.request_id,
                "payload": projects
            })
        }
        "GET_PROJECT" => {
            let project_id = msg.payload.get("id")?.as_str()?;
            let db = state.db.lock().unwrap();
            let mut stmt = db
                .prepare("SELECT data FROM projects WHERE id = ?")
                .ok()?;
            let project_json: Option<String> =
                stmt.query_row(params![project_id], |row| row.get(0)).ok();

            if let Some(data_str) = project_json {
                if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&data_str) {
                    serde_json::json!({
                        "type": "PROJECT_DATA",
                        "requestId": msg.request_id,
                        "payload": json_val
                    })
                } else {
                    serde_json::json!({
                        "type": "ERROR",
                        "requestId": msg.request_id,
                        "payload": "Failed to parse project JSON"
                    })
                }
            } else {
                serde_json::json!({
                    "type": "PROJECT_DATA",
                    "requestId": msg.request_id,
                    "payload": serde_json::Value::Null
                })
            }
        }
        "SAVE_PROJECT" => {
            let project = msg.payload.get("project")?.clone();
            let metadata = project.get("metadata")?;
            let id = metadata.get("id")?.as_str()?.to_string();

            let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
            state.db_tx.send(DbCommand::SaveProject {
                project,
                resp: resp_tx,
            }).await.ok()?;

            match resp_rx.await {
                Ok(Ok(_)) => serde_json::json!({
                    "type": "SAVE_SUCCESS",
                    "requestId": msg.request_id,
                    "payload": { "id": id }
                }),
                Ok(Err(err)) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": format!("Failed to save: {}", err)
                }),
                Err(_) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": "Database task cancelled"
                }),
            }
        }
        "APPLY_DELTA" => {
            let project_id = msg.payload.get("projectId")?.as_str()?.to_string();
            let op = msg.payload.get("op")?.as_str()?.to_string();
            let payload = msg.payload.get("payload")?.clone();

            let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
            state.db_tx.send(DbCommand::ApplyDelta {
                project_id,
                op,
                payload,
                resp: resp_tx,
            }).await.ok()?;

            match resp_rx.await {
                Ok(Ok(_)) => serde_json::json!({
                    "type": "DELTA_ACK",
                    "requestId": msg.request_id,
                    "payload": { "status": "success" }
                }),
                Ok(Err(err)) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": format!("Failed to apply delta: {}", err)
                }),
                Err(_) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": "Database task cancelled"
                }),
            }
        }
        "DELETE_PROJECT" => {
            let id = msg.payload.get("id")?.as_str()?.to_string();

            let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
            state.db_tx.send(DbCommand::DeleteProject {
                id: id.clone(),
                resp: resp_tx,
            }).await.ok()?;

            match resp_rx.await {
                Ok(Ok(_)) => serde_json::json!({
                    "type": "DELETE_SUCCESS",
                    "requestId": msg.request_id,
                    "payload": { "id": id }
                }),
                Ok(Err(err)) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": format!("Failed to delete: {}", err)
                }),
                Err(_) => serde_json::json!({
                    "type": "ERROR",
                    "requestId": msg.request_id,
                    "payload": "Database task cancelled"
                }),
            }
        }
        _ => return None,
    };

    Some(response_payload.to_string())
}

// ─── Native FFmpeg transcode & audio extract helper ───────────

fn run_ffmpeg_transcode(original_path: &str, proxy_path: &str, audio_path: &str) {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&[
        "-y",
        "-i", original_path,
        "-vf", "scale=640:360,fps=30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "28",
        "-g", "30",
        "-keyint_min", "30",
        "-c:a", "aac",
        "-b:a", "96k",
        proxy_path
    ]);
    println!("Running FFmpeg transcode: {:?}", cmd);
    if let Err(e) = cmd.output() {
        eprintln!("Failed to execute FFmpeg transcode: {}", e);
    }

    let mut cmd_audio = std::process::Command::new("ffmpeg");
    cmd_audio.args(&[
        "-y",
        "-i", original_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ac", "1",
        "-ar", "16000",
        audio_path
    ]);
    println!("Running FFmpeg audio extraction: {:?}", cmd_audio);
    let _ = cmd_audio.output();
}

/// Probe a media file's duration (seconds) via ffprobe. Returns None on failure.
fn probe_media_duration(path: &str) -> Option<f64> {
    let output = std::process::Command::new("ffprobe")
        .args(&[
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse::<f64>().ok()
}

// ─── Upload Handler ──────────────────────────────────────────

async fn upload_handler(
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut file_name = String::new();
    let mut file_bytes = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            file_name = field.file_name().unwrap_or("file.mp4").to_string();
            if let Ok(bytes) = field.bytes().await {
                file_bytes = bytes.to_vec();
            }
        }
    }

    if file_bytes.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, "Empty file").into_response();
    }

    let asset_id = uuid::Uuid::new_v4().to_string();
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");

    let original_filename = format!("{}_original.{}", asset_id, ext);
    let proxy_filename = format!("{}_proxy.mp4", asset_id);
    let audio_filename = format!("{}_audio.wav", asset_id);

    let original_path = format!("./shared_storage/{}", original_filename);
    let proxy_path = format!("./shared_storage/{}", proxy_filename);
    let audio_path = format!("./shared_storage/{}", audio_filename);

    if let Err(e) = std::fs::write(&original_path, &file_bytes) {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save file: {}", e)).into_response();
    }

    // The original is on disk now — that's all scene detection / mimic /
    // export need. Transcode the playback proxy + audio in the BACKGROUND so
    // large uploads return immediately instead of blocking on ffmpeg (a
    // 10-minute clip could otherwise hang the request for minutes).
    let orig_p = original_path.clone();
    let prox_p = proxy_path.clone();
    let aud_p = audio_path.clone();
    let audio_path_for_vad = audio_path.clone();
    let asset_id_clone = asset_id.clone();
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            run_ffmpeg_transcode(&orig_p, &prox_p, &aud_p);
        })
        .await;

        let abs_audio_path = match std::fs::canonicalize(&audio_path_for_vad) {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(_) => std::env::current_dir()
                .map(|c| c.join(&audio_path_for_vad).to_string_lossy().to_string())
                .unwrap_or(audio_path_for_vad),
        };

        let client = reqwest::Client::new();
        let _ = client
            .post("http://127.0.0.1:8001/api/ai/reload-cache")
            .send()
            .await;
        let payload = serde_json::json!({
            "element_id": asset_id_clone,
            "audio_path": abs_audio_path,
        });
        let _ = client
            .post("http://127.0.0.1:8001/api/ai/vad")
            .json(&payload)
            .send()
            .await;
    });

    let res = serde_json::json!({
        "asset_id": asset_id,
        "original_path": format!("/static/{}", original_filename),
        "proxy_path": format!("/static/{}", proxy_filename),
        "audio_path": format!("/static/{}", audio_filename),
    });

    Json(res).into_response()
}

// ─── Download Asset Handler ───────────────────────────────────

#[derive(Deserialize)]
struct DownloadRequest {
    url: String,
}

async fn download_asset_handler(
    Json(payload): Json<DownloadRequest>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();
    let res = match client.get(&payload.url).send().await {
        Ok(r) => r,
        Err(e) => return (axum::http::StatusCode::BAD_REQUEST, format!("Failed to download file: {}", e)).into_response(),
    };

    let file_bytes = match res.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return (axum::http::StatusCode::BAD_REQUEST, format!("Failed to read bytes: {}", e)).into_response(),
    };

    let parsed_url = reqwest::Url::parse(&payload.url).ok();
    let file_name = parsed_url
        .and_then(|u| u.path_segments()?.last()?.to_string().into())
        .unwrap_or_else(|| "file.mp4".to_string());

    let asset_id = uuid::Uuid::new_v4().to_string();
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");

    let original_filename = format!("{}_original.{}", asset_id, ext);
    let proxy_filename = format!("{}_proxy.mp4", asset_id);
    let audio_filename = format!("{}_audio.wav", asset_id);

    let original_path = format!("./shared_storage/{}", original_filename);
    let proxy_path = format!("./shared_storage/{}", proxy_filename);
    let audio_path = format!("./shared_storage/{}", audio_filename);

    if let Err(e) = std::fs::write(&original_path, &file_bytes) {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save file: {}", e)).into_response();
    }

    let orig_p = original_path.clone();
    let prox_p = proxy_path.clone();
    let aud_p = audio_path.clone();

    if let Err(e) = tokio::task::spawn_blocking(move || {
        run_ffmpeg_transcode(&orig_p, &prox_p, &aud_p);
    })
    .await
    {
        eprintln!("Transcode task panicked: {}", e);
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Transcode failed: {}", e),
        )
            .into_response();
    }

    let duration = probe_media_duration(&original_path);

    let abs_audio_path = match std::fs::canonicalize(&audio_path) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => {
            if let Ok(curr) = std::env::current_dir() {
                curr.join(&audio_path).to_string_lossy().to_string()
            } else {
                audio_path.clone()
            }
        }
    };

    let asset_id_clone = asset_id.clone();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let _ = client
            .post("http://127.0.0.1:8001/api/ai/reload-cache")
            .send()
            .await;

        let payload = serde_json::json!({
            "element_id": asset_id_clone,
            "audio_path": abs_audio_path,
        });
        let _ = client
            .post("http://127.0.0.1:8001/api/ai/vad")
            .json(&payload)
            .send()
            .await;
    });

    let res_json = serde_json::json!({
        "asset_id": asset_id,
        "name": file_name,
        "original_path": format!("/static/{}", original_filename),
        "proxy_path": format!("/static/{}", proxy_filename),
        "audio_path": format!("/static/{}", audio_filename),
        "duration": duration,
    });

    Json(res_json).into_response()
}

// ─── VAD Webhook Handler ──────────────────────────────────────

#[derive(Deserialize)]
struct VadSegmentJson {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct VadWebhookRequest {
    element_id: String,
    segments: Vec<VadSegmentJson>,
}

async fn vad_webhook_handler(
    State(state): State<AppState>,
    Json(payload): Json<VadWebhookRequest>,
) -> impl IntoResponse {
    println!("Received VAD webhook for element: {}", payload.element_id);
    let conn = state.db.lock().unwrap();

    let _ = conn.execute("DELETE FROM vad_segments WHERE element_id = ?", params![payload.element_id]);

    for seg in payload.segments {
        let seg_id = uuid::Uuid::new_v4().to_string();
        let _ = conn.execute(
            "INSERT INTO vad_segments (id, element_id, start_local, end_local, confidence) VALUES (?, ?, ?, ?, ?)",
            params![seg_id, payload.element_id, seg.start, seg.end, 1.0],
        );
    }

    axum::http::StatusCode::OK
}

// ─── Get Element VAD ──────────────────────────────────────────

#[derive(Serialize)]
struct VadSegmentResponse {
    start: f64,
    end: f64,
}

async fn get_element_vad(
    State(state): State<AppState>,
    axum::extract::Path(element_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT start_local, end_local FROM vad_segments WHERE element_id = ?") {
        Ok(s) => s,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let rows = match stmt.query_map(params![element_id], |row| {
        Ok(VadSegmentResponse {
            start: row.get(0)?,
            end: row.get(1)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let mut segments = Vec::new();
    for r in rows {
        if let Ok(seg) = r {
            segments.push(seg);
        }
    }

    if !segments.is_empty() {
        return Json(segments).into_response();
    }

    // Fallback: look up this element's source_original_path to extract its asset ID, and query vad_segments using that asset_id
    if let Ok(mut stmt_el) = conn.prepare("SELECT source_original_path FROM elements WHERE id = ?") {
        let original_path: Option<String> = stmt_el.query_row(params![element_id], |row| {
            row.get(0)
        }).ok();

        if let Some(path) = original_path {
            let filename = std::path::Path::new(&path).file_name().and_then(|s| s.to_str()).unwrap_or("");
            if let Some(idx) = filename.find("_original") {
                let asset_id = &filename[..idx];
                if let Ok(mut stmt_vad) = conn.prepare("SELECT start_local, end_local FROM vad_segments WHERE element_id = ?") {
                    let rows_res = stmt_vad.query_map(params![asset_id], |row| {
                        Ok(VadSegmentResponse {
                            start: row.get(0)?,
                            end: row.get(1)?,
                        })
                    });
                    if let Ok(rows_vad) = rows_res {
                        for r in rows_vad {
                            if let Ok(seg) = r {
                                segments.push(seg);
                            }
                        }
                    }
                }
            }
        }
    }

    Json(segments).into_response()
}


// ─── Cache reload forwarder ───────────────────────────────────

async fn ai_reload_cache_handler() -> impl IntoResponse {
    tokio::spawn(async {
        let _ = reqwest::Client::new()
            .post("http://127.0.0.1:8001/api/ai/reload-cache")
            .send()
            .await;
    });
    axum::http::StatusCode::OK
}

// ─── Database internal helper functions ───────────────────────

fn save_project_internal(conn: &mut Connection, project: serde_json::Value) -> Result<(), String> {
    let metadata = project.get("metadata").ok_or("Missing metadata")?;
    let id = metadata.get("id").and_then(|i| i.as_str()).ok_or("Missing id")?;
    let name = metadata.get("name").and_then(|n| n.as_str()).ok_or("Missing name")?;
    let duration = metadata.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0);
    let thumbnail = metadata.get("thumbnail").and_then(|t| t.as_str());
    let created_at = metadata.get("createdAt").and_then(|c| c.as_str()).unwrap_or("");
    let updated_at = metadata.get("updatedAt").and_then(|u| u.as_str()).unwrap_or("");
    let data_str = serde_json::to_string(&project).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR REPLACE INTO projects (id, name, duration, thumbnail, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![id, name, duration, thumbnail, created_at, updated_at, data_str],
    ).map_err(|e| e.to_string())?;

    let track_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM tracks WHERE project_id = ?").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for r in rows {
            if let Ok(tid) = r {
                ids.push(tid);
            }
        }
        ids
    };

    for tid in &track_ids {
        let element_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM elements WHERE track_id = ?").map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![tid], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            let mut eids = Vec::new();
            for r in rows {
                if let Ok(eid) = r {
                    eids.push(eid);
                }
            }
            eids
        };
        for eid in &element_ids {
            conn.execute("DELETE FROM keyframes WHERE element_id = ?", params![eid]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM vad_segments WHERE element_id = ?", params![eid]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM elements WHERE id = ?", params![eid]).map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM tracks WHERE id = ?", params![tid]).map_err(|e| e.to_string())?;
    }

    if let Some(scenes) = project.get("scenes").and_then(|s| s.as_array()) {
        for scene in scenes {
            let scene_id = scene.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let scene_name = scene.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let is_main = scene.get("isMain").and_then(|m| m.as_bool()).map(|b| b as i32).unwrap_or(0);
            let sc_created_at = scene.get("createdAt").and_then(|c| c.as_str()).unwrap_or("");
            let sc_updated_at = scene.get("updatedAt").and_then(|u| u.as_str()).unwrap_or("");

            conn.execute(
                "CREATE TABLE IF NOT EXISTS scenes (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    is_main INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )",
                (),
            ).ok();

            conn.execute(
                "INSERT OR REPLACE INTO scenes (id, project_id, name, is_main, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![scene_id, id, scene_name, is_main, sc_created_at, sc_updated_at],
            ).ok();

            if let Some(tracks) = scene.get("tracks").and_then(|t| t.as_array()) {
                for track in tracks {
                    let track_id = track.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    let track_name = track.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let track_type = track.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let is_main = track.get("isMain").and_then(|m| m.as_bool()).map(|b| b as i32);
                    let muted = track.get("muted").and_then(|m| m.as_bool()).map(|b| b as i32);
                    let hidden = track.get("hidden").and_then(|h| h.as_bool()).map(|b| b as i32);

                    conn.execute(
                        "INSERT INTO tracks (id, project_id, name, track_type, is_main, muted, hidden)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                        params![track_id, id, track_name, track_type, is_main, muted, hidden],
                    ).map_err(|e| e.to_string())?;

                    if let Some(elements) = track.get("elements").and_then(|e| e.as_array()) {
                        for element in elements {
                            let element_id = element.get("id").and_then(|i| i.as_str()).unwrap_or("");
                            let element_name = element.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let element_type = element.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            let duration = element.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0);
                            let start_time = element.get("startTime").and_then(|s| s.as_f64()).unwrap_or(0.0);
                            let trim_start = element.get("trimStart").and_then(|s| s.as_f64()).unwrap_or(0.0);
                            let trim_end = element.get("trimEnd").and_then(|e| e.as_f64()).unwrap_or(0.0);
                            let source_duration = element.get("sourceDuration").and_then(|s| s.as_f64());
                            let source_original_path = element.get("sourceOriginalPath").and_then(|s| s.as_str());
                            let source_proxy_path = element.get("sourceProxyPath").and_then(|s| s.as_str());
                            
                            let el_data_str = serde_json::to_string(element).unwrap_or_default();

                            conn.execute(
                                "INSERT INTO elements (id, track_id, name, element_type, duration, start_time, trim_start, trim_end, source_duration, source_original_path, source_proxy_path, data)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                params![element_id, track_id, element_name, element_type, duration, start_time, trim_start, trim_end, source_duration, source_original_path, source_proxy_path, el_data_str],
                            ).map_err(|e| e.to_string())?;

                            if let Some(animations) = element.get("animations") {
                                if let Some(channels) = animations.get("channels").and_then(|c| c.as_object()) {
                                    for (prop, channel) in channels {
                                        if let Some(keyframes) = channel.get("keyframes").and_then(|k| k.as_array()) {
                                            for kf in keyframes {
                                                let kf_id = kf.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                                let kf_time = kf.get("time").and_then(|t| t.as_f64()).unwrap_or(0.0);
                                                let kf_value = kf.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                                let interpolation = kf.get("interpolation").and_then(|i| i.as_str()).unwrap_or("hold");

                                                conn.execute(
                                                    "INSERT INTO keyframes (id, element_id, property, time, value, interpolation)
                                                     VALUES (?, ?, ?, ?, ?, ?)",
                                                    params![kf_id, element_id, prop, kf_time, kf_value, interpolation],
                                                ).map_err(|e| e.to_string())?;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn apply_delta_internal(
    conn: &mut Connection,
    project_id: &str,
    op: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT data FROM projects WHERE id = ?")
        .map_err(|e| e.to_string())?;
    let data_str: String = stmt
        .query_row(params![project_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut project: serde_json::Value =
        serde_json::from_str(&data_str).map_err(|e| e.to_string())?;

    match op {
        "upsert_element" => {
            let element = payload.get("element").ok_or("Missing element")?.clone();
            let element_id = element.get("id").and_then(|i| i.as_str()).ok_or("Missing id")?;
            let track_id = payload.get("trackId").and_then(|t| t.as_str()).ok_or("Missing trackId")?;
            
            let name = element.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let element_type = element.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let duration = element.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0);
            let start_time = element.get("startTime").and_then(|s| s.as_f64()).unwrap_or(0.0);
            let trim_start = element.get("trimStart").and_then(|s| s.as_f64()).unwrap_or(0.0);
            let trim_end = element.get("trimEnd").and_then(|e| e.as_f64()).unwrap_or(0.0);
            let source_duration = element.get("sourceDuration").and_then(|s| s.as_f64());
            let source_original_path = element.get("sourceOriginalPath").and_then(|s| s.as_str());
            let source_proxy_path = element.get("sourceProxyPath").and_then(|s| s.as_str());
            let el_data_str = serde_json::to_string(&element).unwrap_or_default();

            conn.execute(
                "INSERT OR REPLACE INTO elements (id, track_id, name, element_type, duration, start_time, trim_start, trim_end, source_duration, source_original_path, source_proxy_path, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![element_id, track_id, name, element_type, duration, start_time, trim_start, trim_end, source_duration, source_original_path, source_proxy_path, el_data_str],
            ).map_err(|e| e.to_string())?;

            if let Some(scenes) = project.get_mut("scenes").and_then(|s| s.as_array_mut()) {
                for scene in scenes {
                    if let Some(tracks) = scene.get_mut("tracks").and_then(|t| t.as_array_mut()) {
                        for track in tracks {
                            if track.get("id").and_then(|i| i.as_str()) == Some(track_id) {
                                if let Some(elements) = track.get_mut("elements").and_then(|e| e.as_array_mut()) {
                                    elements.retain(|el| el.get("id").and_then(|i| i.as_str()) != Some(element_id));
                                    elements.push(element.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        "delete_element" => {
            let element_id = payload.get("elementId").and_then(|i| i.as_str()).ok_or("Missing elementId")?;
            conn.execute("DELETE FROM elements WHERE id = ?", params![element_id]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM keyframes WHERE element_id = ?", params![element_id]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM vad_segments WHERE element_id = ?", params![element_id]).map_err(|e| e.to_string())?;

            if let Some(scenes) = project.get_mut("scenes").and_then(|s| s.as_array_mut()) {
                for scene in scenes {
                    if let Some(tracks) = scene.get_mut("tracks").and_then(|t| t.as_array_mut()) {
                        for track in tracks {
                            if let Some(elements) = track.get_mut("elements").and_then(|e| e.as_array_mut()) {
                                elements.retain(|el| el.get("id").and_then(|i| i.as_str()) != Some(element_id));
                            }
                        }
                    }
                }
            }
        }
        "upsert_keyframe" => {
            let kf = payload.get("keyframe").ok_or("Missing keyframe")?;
            let kf_id = kf.get("id").and_then(|i| i.as_str()).ok_or("Missing id")?;
            let element_id = payload.get("elementId").and_then(|i| i.as_str()).ok_or("Missing elementId")?;
            let prop = payload.get("property").and_then(|p| p.as_str()).ok_or("Missing property")?;
            let kf_time = kf.get("time").and_then(|t| t.as_f64()).unwrap_or(0.0);
            let kf_value = kf.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let interpolation = kf.get("interpolation").and_then(|i| i.as_str()).unwrap_or("hold");

            conn.execute(
                "INSERT OR REPLACE INTO keyframes (id, element_id, property, time, value, interpolation)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![kf_id, element_id, prop, kf_time, kf_value, interpolation],
            ).map_err(|e| e.to_string())?;

            if let Some(scenes) = project.get_mut("scenes").and_then(|s| s.as_array_mut()) {
                for scene in scenes {
                    if let Some(tracks) = scene.get_mut("tracks").and_then(|t| t.as_array_mut()) {
                        for track in tracks {
                            if let Some(elements) = track.get_mut("elements").and_then(|e| e.as_array_mut()) {
                                for el in elements {
                                    if el.get("id").and_then(|i| i.as_str()) == Some(element_id) {
                                        if let Some(el_obj) = el.as_object_mut() {
                                            let anims = el_obj.entry("animations").or_insert(serde_json::json!({"channels": {}}));
                                            if let Some(anims_obj) = anims.as_object_mut() {
                                                let channels = anims_obj.entry("channels").or_insert(serde_json::json!({}));
                                                if let Some(channels_obj) = channels.as_object_mut() {
                                                    let channel = channels_obj.entry(prop.to_string()).or_insert(serde_json::json!({"valueKind": "number", "keyframes": []}));
                                                    if let Some(kfs) = channel.get_mut("keyframes").and_then(|k| k.as_array_mut()) {
                                                        kfs.retain(|k| k.get("id").and_then(|i| i.as_str()) != Some(kf_id));
                                                        kfs.push(kf.clone());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        "delete_keyframe" => {
            let kf_id = payload.get("keyframeId").and_then(|i| i.as_str()).ok_or("Missing keyframeId")?;
            let element_id = payload.get("elementId").and_then(|i| i.as_str()).ok_or("Missing elementId")?;
            let prop = payload.get("property").and_then(|p| p.as_str()).ok_or("Missing property")?;

            conn.execute("DELETE FROM keyframes WHERE id = ?", params![kf_id]).map_err(|e| e.to_string())?;

            if let Some(scenes) = project.get_mut("scenes").and_then(|s| s.as_array_mut()) {
                for scene in scenes {
                    if let Some(tracks) = scene.get_mut("tracks").and_then(|t| t.as_array_mut()) {
                        for track in tracks {
                            if let Some(elements) = track.get_mut("elements").and_then(|e| e.as_array_mut()) {
                                for el in elements {
                                    if el.get("id").and_then(|i| i.as_str()) == Some(element_id) {
                                        if let Some(anims) = el.get_mut("animations") {
                                            if let Some(channels) = anims.get_mut("channels") {
                                                if let Some(channel) = channels.get_mut(prop) {
                                                    if let Some(kfs) = channel.get_mut("keyframes").and_then(|k| k.as_array_mut()) {
                                                        kfs.retain(|k| k.get("id").and_then(|i| i.as_str()) != Some(kf_id));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => return Err(format!("Unknown delta op: {}", op)),
    }

    let new_data_str = serde_json::to_string(&project).map_err(|e| e.to_string())?;
    
    let metadata = project.get("metadata");
    let duration = metadata.and_then(|m| m.get("duration")).and_then(|d| d.as_f64()).unwrap_or(0.0);
    let name = metadata.and_then(|m| m.get("name")).and_then(|n| n.as_str()).unwrap_or("");
    let updated_at = metadata.and_then(|m| m.get("updatedAt")).and_then(|u| u.as_str()).unwrap_or("");

    conn.execute(
        "UPDATE projects SET name = ?, duration = ?, updated_at = ?, data = ? WHERE id = ?",
        params![name, duration, updated_at, new_data_str, project_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

fn delete_project_internal(conn: &mut Connection, id: &str) -> Result<(), String> {
    let track_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM tracks WHERE project_id = ?").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for r in rows {
            if let Ok(tid) = r {
                ids.push(tid);
            }
        }
        ids
    };

    for tid in &track_ids {
        let element_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM elements WHERE track_id = ?").map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![tid], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            let mut eids = Vec::new();
            for r in rows {
                if let Ok(eid) = r {
                    eids.push(eid);
                }
            }
            eids
        };
        for eid in &element_ids {
            conn.execute("DELETE FROM keyframes WHERE element_id = ?", params![eid]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM vad_segments WHERE element_id = ?", params![eid]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM elements WHERE id = ?", params![eid]).map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM tracks WHERE id = ?", params![tid]).map_err(|e| e.to_string())?;
    }

    conn.execute("DELETE FROM projects WHERE id = ?", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── AI Status ───────────────────────────────────────────────

#[derive(Serialize)]
struct AiStatus {
    device: String,
    status: String,
    hardware_accelerated: bool,
}

async fn get_ai_status() -> Json<AiStatus> {
    Json(AiStatus {
        device: "CPU".to_string(),
        status: "ready".to_string(),
        hardware_accelerated: false,
    })
}

#[derive(Deserialize)]
struct ExecuteParams {
    prompt: String,
    project_id: String,
}

#[derive(Serialize)]
struct ExecuteResult {
    task_id: String,
    status: String,
}

#[derive(Deserialize)]
struct SearchParams {
    prompt: String,
    api_key: Option<String>,
}

async fn ai_vector_search_handler(
    Json(params): Json<SearchParams>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();

    // 1. Get embedding from Ollama nomic-embed-text
    let embed_payload = serde_json::json!({
        "model": "nomic-embed-text",
        "prompt": params.prompt
    });

    let mut query_vector = vec![0.0f64; 512];

    let base_url = std::env::var("OLLAMA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
    let url = format!("{}/api/embeddings", base_url.trim_end_matches('/'));

    let mut req = client.post(&url).json(&embed_payload);
    if let Some(ref key) = params.api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            req = req.header("Authorization", format!("Bearer {trimmed}"));
        }
    }

    if let Ok(res) = req.send().await {
        if let Ok(body) = res.json::<serde_json::Value>().await {
            if let Some(embedding) = body.get("embedding").and_then(|e| e.as_array()) {
                query_vector = embedding.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
                if query_vector.len() > 512 {
                    query_vector.truncate(512);
                } else {
                    while query_vector.len() < 512 {
                        query_vector.push(0.0);
                    }
                }
            }
        }
    }

    // Fallback hashing for deterministic search testing if nomic is unavailable
    if query_vector.iter().all(|&x| x == 0.0) {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        for i in 0..512 {
            let mut hasher = DefaultHasher::new();
            params.prompt.hash(&mut hasher);
            i.hash(&mut hasher);
            let h = hasher.finish();
            query_vector[i] = ((h % 1000) as f64) / 1000.0;
        }
    }

    // 2. Call Python Worker at http://127.0.0.1:8001/api/ai/search
    let search_payload = serde_json::json!({
        "query_vector": query_vector,
        "top_k": 5
    });

    if let Ok(res) = client
        .post("http://127.0.0.1:8001/api/ai/search")
        .json(&search_payload)
        .send()
        .await
    {
        if let Ok(body) = res.json::<serde_json::Value>().await {
            return Json(body).into_response();
        }
    }

    Json(serde_json::json!({
        "results": []
    })).into_response()
}

#[derive(Deserialize, Debug)]
struct ExportRequest {
    project: serde_json::Value,
}

#[derive(Serialize, Debug)]
struct ExportResponse {
    status: String,
    url: Option<String>,
    error: Option<String>,
}

async fn export_project_handler(
    State(_state): State<AppState>,
    Json(payload): Json<ExportRequest>,
) -> impl IntoResponse {
    let timeline_data = &payload.project;
    
    let temp_id = uuid::Uuid::new_v4().to_string();
    let temp_json_path = format!("./shared_storage/temp_timeline_{}.json", temp_id);
    let output_mp4_name = format!("output_{}.mp4", temp_id);
    let output_mp4_path = format!("./shared_storage/{}", output_mp4_name);
    
    if let Ok(file_content) = serde_json::to_string(timeline_data) {
        if std::fs::write(&temp_json_path, file_content).is_ok() {
            let exporter_path = if std::path::Path::new("services/ai-worker/exporter.py").exists() {
                "services/ai-worker/exporter.py"
            } else {
                "../ai-worker/exporter.py"
            };

            let mut cmd = tokio::process::Command::new("python3");
            cmd.args(&[exporter_path, &temp_json_path, &output_mp4_path]);
            
            match cmd.output().await {
                Ok(output) => {
                    std::fs::remove_file(&temp_json_path).ok();
                    
                    if output.status.success() {
                        let url = format!("/static/{}", output_mp4_name);
                        return Json(ExportResponse {
                            status: "success".to_string(),
                            url: Some(url),
                            error: None,
                        }).into_response();
                    } else {
                        let stdout_msg = String::from_utf8_lossy(&output.stdout).to_string();
                        let stderr_msg = String::from_utf8_lossy(&output.stderr).to_string();
                        let err_msg = format!("{}{}", stdout_msg, stderr_msg);
                        println!("Exporter execution failed: {}", err_msg);
                        return Json(ExportResponse {
                            status: "error".to_string(),
                            url: None,
                            error: Some(err_msg),
                        }).into_response();
                    }
                }
                Err(e) => {
                    std::fs::remove_file(&temp_json_path).ok();
                    return Json(ExportResponse {
                        status: "error".to_string(),
                        url: None,
                        error: Some(e.to_string()),
                    }).into_response();
                }
            }
        }
    }

    Json(ExportResponse {
        status: "error".to_string(),
        url: None,
        error: Some("Failed to serialize timeline data".to_string()),
    }).into_response()
}

#[derive(Deserialize, Serialize, Debug)]
struct MimicFlowRequest {
    reference_video_path: String,
    target_audio_path: Option<String>,
    target_video_path: Option<String>,
    target_video_duration: f64,
}

#[derive(Deserialize)]
struct SceneMapRequest {
    video_path: String,
    threshold: Option<f64>,
}

// Proxy scene-map to the Python worker, resolving /static paths to absolute
// filesystem paths (server-side ffmpeg decode works on files the browser can't).
async fn ai_scene_map_handler(
    State(_state): State<AppState>,
    Json(payload): Json<SceneMapRequest>,
) -> impl IntoResponse {
    let resolved = resolve_static_path_to_abs(&payload.video_path);
    let body = serde_json::json!({
        "video_path": resolved,
        "threshold": payload.threshold.unwrap_or(27.0),
    });
    let client = reqwest::Client::new();
    match client
        .post("http://127.0.0.1:8001/api/ai/scene-map")
        .json(&body)
        .send()
        .await
    {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to parse scene-map response: {}", e),
            )
                .into_response(),
        },
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Scene-map worker request failed: {}", e),
        )
            .into_response(),
    }
}

fn resolve_static_path_to_abs(path: &str) -> String {
    if path.starts_with("/static/") {
        let suffix = &path["/static/".len()..];
        let rel_path = format!("./shared_storage/{}", suffix);
        if let Ok(abs) = std::fs::canonicalize(&rel_path) {
            abs.to_string_lossy().to_string()
        } else {
            if let Ok(curr) = std::env::current_dir() {
                curr.join(&rel_path).to_string_lossy().to_string()
            } else {
                rel_path
            }
        }
    } else {
        path.to_string()
    }
}

#[derive(Deserialize, Serialize, Debug)]
struct WriteBackRequest {
    searchable: String,
    situation: serde_json::Value,
    decision: String,
    reason: String,
    confidence: Option<f64>,
    source: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
struct QueryEpisodicRequest {
    #[serde(alias = "the_loai")]
    genre: Option<String>,
    #[serde(alias = "loai_quyet_dinh")]
    decision_type: Option<String>,
    query_text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct EpisodicMemoryRecord {
    id: String,
    timestamp: String,
    searchable: String,
    situation: serde_json::Value,
    decision: String,
    reason: String,
    confidence: f64,
    source: String,
    status: String,
}

fn jaccard_similarity(s1: &str, s2: &str) -> f64 {
    let w1: std::collections::HashSet<&str> = s1.split_whitespace()
        .map(|s| s.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|s| !s.is_empty())
        .collect();
    let w2: std::collections::HashSet<&str> = s2.split_whitespace()
        .map(|s| s.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|s| !s.is_empty())
        .collect();
    if w1.is_empty() && w2.is_empty() {
        return 1.0;
    }
    let intersection = w1.intersection(&w2).count() as f64;
    let union = w1.union(&w2).count() as f64;
    intersection / union
}

async fn ai_write_back_handler(
    State(state): State<AppState>,
    Json(payload): Json<WriteBackRequest>,
) -> impl IntoResponse {
    let id = uuid::Uuid::new_v4().to_string();
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let now = secs.to_string();
    let situation_str = serde_json::to_string(&payload.situation).unwrap_or_default();
    
    let db = state.db.lock().unwrap();
    let res = db.execute(
        "INSERT INTO episodic_memory (id, timestamp, searchable, situation, decision, reason, confidence, source, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            now,
            payload.searchable,
            situation_str,
            payload.decision,
            payload.reason,
            payload.confidence.unwrap_or(1.0),
            payload.source.unwrap_or_else(|| "user_edit".to_string()),
            payload.status.unwrap_or_else(|| "active".to_string()),
        ],
    );

    match res {
        Ok(_) => (axum::http::StatusCode::OK, Json(serde_json::json!({ "status": "success", "id": id }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save episodic memory: {}", e)).into_response(),
    }
}

async fn ai_query_episodic_handler(
    State(state): State<AppState>,
    Json(payload): Json<QueryEpisodicRequest>,
) -> impl IntoResponse {
    let db = state.db.lock().unwrap();
    let mut stmt = match db.prepare("SELECT id, timestamp, searchable, situation, decision, reason, confidence, source, status FROM episodic_memory") {
        Ok(s) => s,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to prepare query: {}", e)).into_response(),
    };

    let records_iter = match stmt.query_map((), |row| {
        let sit_str: String = row.get(3)?;
        let sit_val: serde_json::Value = serde_json::from_str(&sit_str).unwrap_or(serde_json::Value::Null);
        Ok(EpisodicMemoryRecord {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            searchable: row.get(2)?,
            situation: sit_val,
            decision: row.get(4)?,
            reason: row.get(5)?,
            confidence: row.get(6)?,
            source: row.get(7)?,
            status: row.get(8)?,
        })
    }) {
        Ok(iter) => iter,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to execute query: {}", e)).into_response(),
    };

    let mut matched_records = Vec::new();
    for r in records_iter {
        if let Ok(rec) = r {
            // Apply pre-filter: genre and decision_type if specified
            if let Some(ref filter_loai) = payload.genre {
                if let Some(t) = rec.situation.get("genre").or_else(|| rec.situation.get("the_loai")).and_then(|x| x.as_str()) {
                    if t != filter_loai {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            if let Some(ref filter_qd) = payload.decision_type {
                if let Some(qd) = rec.situation.get("decision_type").or_else(|| rec.situation.get("loai_quyet_dinh")).and_then(|x| x.as_str()) {
                    let normalized_qd = if qd == "cut_hay_giữ" { "cut_or_keep" } else { qd };
                    let normalized_filter = if filter_qd == "cut_hay_giữ" { "cut_or_keep" } else { filter_qd };
                    if normalized_qd != normalized_filter {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            // Calculate Jaccard score
            let score = jaccard_similarity(&payload.query_text, &rec.searchable);
            matched_records.push((rec, score));
        }
    }

    // Sort descending by Jaccard similarity score
    matched_records.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Limit to top 5
    let result: Vec<EpisodicMemoryRecord> = matched_records.into_iter()
        .take(5)
        .map(|(rec, _)| rec)
        .collect();

    Json(result).into_response()
}

async fn ai_mimic_flow_handler(
    State(_state): State<AppState>,
    Json(payload): Json<MimicFlowRequest>,
) -> impl IntoResponse {
    let resolved_ref = resolve_static_path_to_abs(&payload.reference_video_path);
    let resolved_audio = payload.target_audio_path.as_ref().map(|path| resolve_static_path_to_abs(path));
    let resolved_target_video = payload.target_video_path.as_ref().map(|path| resolve_static_path_to_abs(path));
    
    let python_payload = serde_json::json!({
        "reference_video_path": resolved_ref,
        "target_audio_path": resolved_audio,
        "target_video_path": resolved_target_video,
        "target_video_duration": payload.target_video_duration,
    });

    let client = reqwest::Client::new();
    match client
        .post("http://127.0.0.1:8001/api/ai/mimic-flow")
        .json(&python_payload)
        .send()
        .await
    {
        Ok(res) => {
            if let Ok(body) = res.json::<serde_json::Value>().await {
                Json(body).into_response()
            } else {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to parse python response",
                )
                    .into_response()
            }
        }
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Python worker request failed: {}", e),
        )
            .into_response(),
    }
}

async fn execute_ai_task(Json(params): Json<ExecuteParams>) -> impl IntoResponse {
    println!(
        "Received execution request for project {}: {}",
        params.project_id, params.prompt
    );
    let result = ExecuteResult {
        task_id: "mock_task_id".to_string(),
        status: "queued".to_string(),
    };
    (axum::http::StatusCode::ACCEPTED, Json(result))
}

// ─── Vision Tag (Scene Tagging via Ollama gemma4) ────────────

#[derive(Deserialize)]
struct VisionTagRequest {
    image: String,
    api_key: Option<String>,
}

#[derive(Serialize)]
struct VisionTagResponse {
    tag: String,
}

async fn vision_tag_handler(Json(params): Json<VisionTagRequest>) -> impl IntoResponse {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_default();

    let payload = serde_json::json!({
        "model": "gemma4:12b",
        "messages": [{
            "role": "user",
            "content": "Describe this video scene in 5-8 English words. Examples: 'outdoor cliff landscape overcast sky', 'indoor studio warm yellow lighting', 'night street neon city rain', 'close up portrait soft window light'. Return ONLY the tag, nothing else. No quotes, no explanation.",
            "images": [params.image]
        }],
        "stream": false
    });

    let base_url = std::env::var("OLLAMA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

    let mut req = client.post(&url).json(&payload);
    if let Some(ref key) = params.api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            req = req.header("Authorization", format!("Bearer {trimmed}"));
        }
    } else if let Ok(env_key) = std::env::var("OLLAMA_API_KEY") {
        if !env_key.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", env_key.trim()));
        }
    }

    match req.send().await {
        Ok(res) => {
            if let Ok(body) = res.json::<serde_json::Value>().await {
                let tag = body["message"]["content"]
                    .as_str()
                    .unwrap_or("unknown scene")
                    .trim()
                    .trim_matches('"')
                    .to_string();
                Json(VisionTagResponse { tag }).into_response()
            } else {
                Json(VisionTagResponse {
                    tag: "unknown scene".to_string(),
                })
                .into_response()
            }
        }
        Err(e) => {
            eprintln!("Vision tag error: {}", e);
            Json(VisionTagResponse {
                tag: "unknown scene".to_string(),
            })
            .into_response()
        }
    }
}

// ─── Chat Handler (Ollama streaming) ─────────────────────────

#[derive(Deserialize, Serialize, Debug)]
struct ObsidianGraphWeights {
    pacing: Option<f64>,
    cinematic_grading: Option<f64>,
    dynamic_contrast: Option<f64>,
    audio_sensitivity: Option<f64>,
}

#[derive(Deserialize)]
struct ChatRequest {
    prompt: String,
    project_id: String,
    mode: Option<String>,
    timeline_state: Option<String>,
    color_stats: Option<String>,
    scene_map: Option<String>,
    time_range: Option<Vec<f64>>,
    local_model: Option<String>,
    obsidian_graph_weights: Option<ObsidianGraphWeights>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

const SYSTEM_PROMPT: &str = r##"You are Smart Copilot — a professional, highly intelligent video editing and audio assistant.

=== SECURITY & OUT-OF-SCOPE REFUSAL (CRITICAL) ===
You must strictly refuse to answer any queries that are not directly related to video editing, NLE operations, audio processing, color grading, visual frame details, or the editing application.
Note: requests asking to analyze, mimic, or describe video styles ("analyze the technique", "mimic the style", "apply color filter", "analyse reference") are FULLY IN-SCOPE and should be resolved with corresponding timeline operations.
If the user asks questions such as "who is the US president", general knowledge, coding advice, math, history, or anything else out of scope:
- You MUST answer exactly: "I am a smart video editing assistant. I can only assist with video editing, color matching, audio ducking, and timeline operations."
- Do NOT output any editing operations in the JSON.
- Do NOT provide the out-of-scope answer.

=== FLEXIBLE EDITING & COMPOSITION PHILOSOPHY ===
You have full creative freedom to compose any sequence of operations. Avoid being rigid, formulaic, or restricted to a fixed template of "12 skills". Instead, listen carefully to the user's intent and combine the available operations in the schema dynamically, accurately, and intelligently to match their request.

=== COLOR WHEELS PRESETS ===
Use these 3-Way color wheels presets in "adjust_color" as suggestions or adjust them freely:
- "Cinematic" (Orange & Teal): lift_b=0.05, lift_g=0.02, lift_r=-0.03, gain_r=1.12, gain_g=1.06, gain_b=0.90, contrast=0.15, saturation=0.05.
- "Vintage Film": saturation=-0.18, lift_r=0.03, lift_g=0.01, lift_b=-0.02, gain_r=1.08, gain_b=0.93, shadows=0.08, contrast=-0.05.
- "Cyberpunk Neon": contrast=0.25, exposure=-0.08, lift_b=0.08, lift_g=0.03, lift_r=-0.05, gain_r=1.30, gain_b=1.30, gain_g=0.75, saturation=0.15.

=== CRITICAL RULES ===
1. Think internally inside <thought>...</thought> tags.
2. ALWAYS use real clip_ids from the CURRENT TIMELINE STATE provided in the user context.
3. NEVER make up dummy or placeholder IDs.
4. Keep assistant reply extremely concise, max 2 sentences, followed by the JSON block.
5. If the timeline is empty, politely ask the user to add video clips first.
6. If the user requests multiple edits, you MUST include ALL corresponding operations in the "operations" array in the correct order. Do not omit any.
7. Strictly refuse to answer general knowledge, historical, political, coding, or other out-of-scope queries. You MUST reply exactly: "I am a smart video editing assistant. I can only assist with video editing, color matching, audio ducking, and timeline operations."
8. Chroma keying ("chroma_key") and mask inpainting ("mask_inpainting") are DEPRECATED. Do not propose these actions.

=== TARGETING RULES ===
- The CURRENT TIMELINE STATE lists every track and clip. Copy clip_id values EXACTLY.
- Every time value ("time", "start", "end") is in SECONDS on the GLOBAL timeline, and MUST lie inside the target clip's [start → end] range shown in the state.
- "split" time must be strictly between the clip's timeline start and end (never at the exact boundary).
- "trim" start/end describe the portion of the clip to KEEP.
- When the user names a track or time range, only touch clips matching that criteria.
- If the user's request is ambiguous about WHICH clip, prefer the clip currently under the selection, and say which clip you chose in your reply.

=== OPERATIONS SCHEMA ===
Only these actions exist. NEVER invent other action names.
- {"action":"trim","clip_id":"<ID>","start":5.0,"end":10.0}            // keep range [start,end]
- {"action":"split","clip_id":"<ID>","time":5.0}                       // global timeline seconds
- {"action":"delete","clip_id":"<ID>"}
- {"action":"demux_audio","clip_id":"<ID>","offset":0.0}               // detach audio; negative offset = J-Cut, positive = L-Cut
- {"action":"duplicate_layer","clip_id":"<ID>","with_mask":true,"mask_type":"rectangle|ellipse","invert":false,"feather":10}
- {"action":"mux_audio","audio_asset_id":"<ID>","audio_name":"Name","start":0.0,"duration":10.0}
- {"action":"add_overlay","asset_id":"<ID>","overlay_type":"video|image","name":"Overlay","start":0.0,"duration":5.0,"x":0,"y":0,"scale":0.5,"rotation":0}
- {"action":"transform","clip_id":"<ID>","position_x":0,"position_y":0,"scale":1.2,"rotation":45}
- {"action":"change_speed","clip_id":"<ID>","speed":2.0,"maintain_pitch":true,"reverse":false,"curve":"ease_in|ease_out|ease_in_out"}
- {"action":"adjust_volume","clip_id":"<ID>","volume":0.5}  // volume: 0.0 = mute, 1.0 = normal, 2.0 = double
- {"action":"blend_mode","clip_id":"<ID>","opacity":0.8,"blend_mode":"normal|multiply|screen|overlay|darken"}
- {"action":"add_mask","clip_id":"<ID>","mask_type":"rectangle|ellipse","invert":false,"feather":10}
- {"action":"add_subtitle","text":"...","start":0,"end":5}
- {"action":"auto_scene_cut","clip_id":"<ID>","keep_only_scenery":false,"color_preset":"cinematic","mute":false}
  // IMPORTANT: Use this when the user wants to split/cut a clip into its natural scenes.
  // - "keep_only_scenery": defaults to FALSE. ONLY set to TRUE if the user explicitly asks to remove people/talking shots or keep scenery/b-roll only. If they just ask to split into scenes (split/detect scenes), keep_only_scenery MUST be FALSE!
  // - "mute": defaults to FALSE. Only set to TRUE if they ask to mute the clip.
  // - "color_preset": optional color preset name.
- {"action":"voice_isolation","clip_id":"<ID>","enabled":true}
- {"action":"stabilize","clip_id":"<ID>","enabled":true}
- {"action":"add_effect","clip_id":"<ID>","effect_type":"grayscale|invert|vignette|blur|camera-shake|halation|glitch|letterbox|lut_grade|film_edge","params":{}}
  // "params" is OPTIONAL and effect-specific. Examples:
  //   camera-shake: {"amplitude":0.015,"frequency":12}   halation: {"radius":8,"intensity":0.7,"threshold":0.65}
  //   glitch: {"intensity":0.5}   letterbox: {"aspectRatio":2.39}   lut_grade: {"intensity":1.0,"logProfile":0,"lumaVsSatBottom":0.15}
  //   film_edge: {"depth":6,"roughness":9,"softness":1,"grain":15}   blur: {"radius":5}   vignette: {"intensity":0.5}
- {"action":"adjust_color","clip_id":"<ID>","params":{"brightness":0.0,"contrast":0.0,"saturation":0.0,"exposure":0.0,"temperature":0.0,"tint":0.0,"highlights":0.0,"shadows":0.0,"lift_r":0.0,"lift_g":0.0,"lift_b":0.0,"gamma_r":1.0,"gamma_g":1.0,"gamma_b":1.0,"gain_r":1.0,"gain_g":1.0,"gain_b":1.0}}

=== PER-SEGMENT COLOR GRADING (CRITICAL) ===
When the user asks to grade each scene/segment with different colors:
- Each clip in the CURRENT TIMELINE STATE may have a scene="..." attribute describing its visual content (e.g. "person talking", "landscape", "night cityscape").
- You MUST emit a separate adjust_color operation for EACH clip with DIFFERENT color parameters tailored to the scene content:
  * Scenes with "person"/"human"/"talking" → warm tones: positive temperature (0.1-0.3), gain_r > 1.0, gain_b < 1.0
  * Scenes with "scenery"/"landscape"/"nature" → cool tones: negative temperature (-0.1 to -0.3), lift_b > 0, gain_b > 1.0
  * Scenes with "action"/"sport"/"fast" → high contrast (0.2-0.3), desaturated slightly
  * Scenes with "night"/"dark"/"indoor" → lift shadows (lift_r/g/b > 0), boost exposure
  * Default/unknown → subtle cinematic grade
- Do NOT apply the same parameters to all clips. Each clip_id must have visually distinct grading.

=== OUTPUT FORMAT ===
Short explanation, then:
```json
{"operations":[...]}
```"##;

async fn chat_handler(
    State(_state): State<AppState>,
    Json(params): Json<ChatRequest>,
) -> impl IntoResponse {
    let mode_str = params.mode.as_deref().unwrap_or("local");
    println!(
        "Received chat prompt for project {} (Mode: {}): {}",
        params.project_id, mode_str, params.prompt
    );

    let client = reqwest::Client::new();

    // Build user message with all context
    let mut user_content = String::new();

    if let Some(ref state) = params.timeline_state {
        user_content.push_str(&format!(
            "=== CURRENT TIMELINE STATE ===\n{}\n=== END CURRENT TIMELINE STATE ===\n\n",
            state
        ));
    }

    if let Some(ref stats) = params.color_stats {
        user_content.push_str(&format!(
            "=== CURRENT FRAME COLOR ANALYSIS ===\n{}\n=== END COLOR ANALYSIS ===\n\n",
            stats
        ));
    }

    if let Some(ref scene_map) = params.scene_map {
        user_content.push_str(&format!("{}\n\n", scene_map));
    }

    if let Some(ref time_range) = params.time_range {
        if time_range.len() == 2 {
            user_content.push_str(&format!(
                "=== SELECTED TIME RANGE ===\nOnly edit clips within [{:.1}s -> {:.1}s]. Do NOT touch clips outside this range.\n=== END SELECTED TIME RANGE ===\n\n",
                time_range[0], time_range[1]
            ));
        }
    }

    user_content.push_str(&format!("User Request: {}", params.prompt));

    println!("Ollama User Content:\n{}", user_content);

    // Build dynamic system prompt containing Obsidian Graph weight constraints
    let mut system_prompt = SYSTEM_PROMPT.to_string();
    if let Some(ref weights) = params.obsidian_graph_weights {
        system_prompt.push_str("\n=== USER CREATIVE WEIGHTS & CONSTRAINTS ===\n");
        if let Some(pacing) = weights.pacing {
            system_prompt.push_str(&format!(
                "- Pacing parameter is set to {:.2}. ",
                pacing
            ));
            if pacing > 0.8 {
                system_prompt.push_str("User prefers highly aggressive fast cuts. Constraint intervals must be strictly limited to 0.8s - 1.2s.\n");
            } else if pacing < 0.3 {
                system_prompt.push_str("User prefers slow, cinematic pacing. Avoid splitting clips frequently.\n");
            } else {
                system_prompt.push_str("Maintain standard pacing.\n");
            }
        }
        if let Some(grading) = weights.cinematic_grading {
            system_prompt.push_str(&format!(
                "- Cinematic Grading parameter is set to {:.2}. ",
                grading
            ));
            if grading > 0.7 {
                system_prompt.push_str("Prioritize deep orange & teal or vintage film color grading presets.\n");
            }
        }
        if let Some(contrast) = weights.dynamic_contrast {
            system_prompt.push_str(&format!(
                "- Dynamic Contrast parameter is set to {:.2}. Ensure contrast levels in adjust_color match this intent.\n",
                contrast
            ));
        }
        if let Some(sensitivity) = weights.audio_sensitivity {
            system_prompt.push_str(&format!(
                "- Audio Sensitivity parameter is set to {:.2}. Prioritize audio ducking volume drop down to -20dB during voiceovers.\n",
                sensitivity
            ));
        }
    }
    println!("Ollama System Prompt:\n{}", system_prompt);

    let messages = vec![
        serde_json::json!({
            "role": "system",
            "content": system_prompt
        }),
        serde_json::json!({
            "role": "user",
            "content": user_content
        }),
    ];

    let provider = params
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .or_else(|| {
            params
                .api_key
                .as_deref()
                .and_then(detect_provider_from_key)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "gemini".into());

    let messages_val = serde_json::json!(messages);

    if provider == "ollama" || provider == "local" {
        let model_name = params.model.as_deref().unwrap_or("qwen3.5:9b");
        let payload = serde_json::json!({
            "model": model_name,
            "messages": messages_val,
            "stream": true,
            "think": false,
            "options": {
                "temperature": 0.3,
                "num_ctx": 8192,
                "num_predict": 1024
            }
        });

        let base_url = std::env::var("OLLAMA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
        let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

        let mut req = client.post(&url).json(&payload);
        if let Some(ref key) = params.api_key {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                req = req.header("Authorization", format!("Bearer {trimmed}"));
            }
        }

        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                return (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to connect to Ollama: {}", e),
                )
                    .into_response();
            }
        };

        let byte_stream = res.bytes_stream();
        let pin_stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>> =
            Box::pin(byte_stream);

        let body = axum::body::Body::from_stream(pin_stream);

        axum::response::Response::builder()
            .header("Content-Type", "application/x-ndjson")
            .header("Transfer-Encoding", "chunked")
            .body(body)
            .unwrap()
            .into_response()
    } else {
        let result = match provider.as_str() {
            "gemini" | "google" => {
                let key = resolve_key(&params.api_key, "GEMINI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gemini-2.0-flash".into());
                        agent_step_gemini(&model, &k, &messages_val, &serde_json::json!([])).await
                    }
                    Err(e) => Err(e),
                }
            }
            "openai" => {
                let key = resolve_key(&params.api_key, "OPENAI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gpt-4o-mini".into());
                        agent_step_openai_compat(
                            &model,
                            "https://api.openai.com/v1/chat/completions",
                            &k,
                            &messages_val,
                            &serde_json::json!([]),
                        )
                        .await
                    }
                    Err(e) => Err(e),
                }
            }
            "grok" | "xai" => {
                let key = resolve_key(&params.api_key, "XAI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "grok-4-latest".into());
                        agent_step_openai_compat(
                            &model,
                            "https://api.x.ai/v1/chat/completions",
                            &k,
                            &messages_val,
                            &serde_json::json!([]),
                        )
                        .await
                    }
                    Err(e) => Err(e),
                }
            }
            "anthropic" | "claude" => {
                let key = resolve_key(&params.api_key, "ANTHROPIC_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "claude-3-5-haiku-latest".into());
                        agent_step_anthropic(&model, &k, &messages_val, &serde_json::json!([])).await
                    }
                    Err(e) => Err(e),
                }
            }
            other => Err(format!("Unknown provider: {}", other)),
        };

        match result {
            Ok(v) => {
                let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
                let ndjson_line = serde_json::json!({
                    "message": {
                        "role": "assistant",
                        "content": content
                    }
                }).to_string();
                let response_body = format!("{}\n", ndjson_line);

                axum::response::Response::builder()
                    .header("Content-Type", "application/x-ndjson")
                    .body(axum::body::Body::from(response_body))
                    .unwrap()
                    .into_response()
            }
            Err(e) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
            }
        }
    }
}

// ─── Agentic tool-calling step ────────────────────────────────
// One turn of the agent loop: the frontend passes the running message history
// plus the available NLE tools; we ask Ollama (non-streaming) for the next
// tool call. The frontend executes it, appends the result, and calls again —
// this is what makes the local model an autonomous editing agent instead of a
// single-shot op generator.
// The canonical request/response shape is the OpenAI/Ollama chat format:
//   request  = { messages, tools, provider, model }
//   response = { content, tool_calls, usage }
// The backend is the ONLY place that knows each provider's dialect — it
// translates the canonical format to Gemini / OpenAI / Grok / Anthropic / local
// and back, so the frontend agent loop stays provider-agnostic. API keys live
// in the backend env (loaded from .env) and never touch the frontend.
#[derive(Deserialize)]
struct AgentStepRequest {
    messages: serde_json::Value,
    tools: serde_json::Value,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    api_key: Option<String>, // user-supplied key from the app UI (preferred over env)
    #[serde(default)]
    local_model: Option<String>, // legacy alias for the ollama model
}

/// Detect the provider from the API key's format.
fn detect_provider_from_key(key: &str) -> Option<&'static str> {
    let k = key.trim();
    if k.is_empty() {
        return Some("ollama");
    }
    // Google has two key formats: legacy "AIza…" and the newer "AQ.…".
    if k.starts_with("AIza") || k.starts_with("AQ.") {
        return Some("gemini");
    }
    if k.starts_with("sk-ant-") {
        return Some("anthropic");
    }
    if k.starts_with("xai-") {
        return Some("grok");
    }
    if k.starts_with("sk-") {
        return Some("openai");
    }
    None
}

/// Resolve an API key: prefer the one supplied by the app UI, else backend env.
fn resolve_key(user_key: &Option<String>, env_name: &str) -> Result<String, String> {
    if let Some(k) = user_key {
        let k = k.trim();
        if !k.is_empty() {
            return Ok(k.to_string());
        }
    }
    std::env::var(env_name)
        .map_err(|_| format!("No API key: paste a key in the app or set {env_name} in .env"))
}

// ─── Vision Colour Grading (multi-provider) ──────────────────
// Sends each scene's actual frame to a vision LLM and lets it design a
// bespoke, self-tuned grade per scene — no hardcoded presets or rules.

#[derive(Deserialize, Debug)]
struct SceneFrameInput {
    index: i64,
    #[serde(default)]
    image: String, // base64 JPEG (data-URL prefix tolerated)
    #[serde(default)]
    hint: String,
}

#[derive(Deserialize, Debug)]
struct GradeScenesRequest {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    scenes: Vec<SceneFrameInput>,
}

fn colorist_system_prompt() -> String {
    "You are a senior film colorist grading a montage. You are shown the scenes of one edit IN ORDER, each as a real frame image plus quick stats. \
Design a colour grade for EACH scene that: (1) suits its actual light, subject and mood — look at the pixels; (2) is visibly DISTINCT from the scenes immediately before/after it so the montage has colour variety; (3) together with the others forms a cohesive, intentional palette. \
Grade like DaVinci Resolve: subtle lift/gamma/gain, believable temperature/tint, gentle contrast and saturation. NEVER wash a heavy flat single-colour tint over the whole frame. \
Return ONLY minified JSON, no prose, no code fences: {\"grades\":[{\"scene\":<index>,\"rationale\":\"<short reason>\",\"params\":{...}}]}. \
params keys (all optional — omit neutral ones): brightness,contrast,saturation,exposure,temperature,tint,highlights,shadows,lift_r,lift_g,lift_b,gamma_r,gamma_g,gamma_b,gain_r,gain_g,gain_b. \
Ranges: lift ±0.3, gamma 0.7–1.4, gain 0.7–1.4, contrast/saturation/temperature/tint ±0.5, exposure ±1. Provide one entry per scene, matching its index.".to_string()
}

fn strip_data_url(b64: &str) -> &str {
    match b64.rfind("base64,") {
        Some(i) => &b64[i + 7..],
        None => b64,
    }
}

/// Standard base64 encode (no external crate).
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Grab one frame from a video at `time` seconds as base64 JPEG (scaled to
/// 512px wide) via ffmpeg piped to stdout — the "eyes" for recipe extraction.
async fn extract_frame_b64(path: &str, time: f64) -> Option<String> {
    let out = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-ss",
            &format!("{:.3}", time),
            "-i",
            path,
            "-frames:v",
            "1",
            "-vf",
            "scale=512:-1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ])
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }
    Some(b64_encode(&out.stdout))
}

/// Pull the first JSON object out of a model reply (tolerates fences/prose).
fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        return Some(v);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        serde_json::from_str::<serde_json::Value>(&text[start..=end]).ok()
    } else {
        None
    }
}

async fn vision_scenes_gemini(
    system: &str,
    model: &str,
    key: &str,
    scenes: &[SceneFrameInput],
) -> Result<String, String> {
    let mut parts: Vec<serde_json::Value> = vec![serde_json::json!({
        "text": "Here are the scenes in order."
    })];
    for s in scenes {
        parts.push(serde_json::json!({"text": format!("Scene {}: {}", s.index, s.hint)}));
        parts.push(serde_json::json!({
            "inline_data": {"mime_type": "image/jpeg", "data": strip_data_url(&s.image)}
        }));
    }
    let req = serde_json::json!({
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.45, "maxOutputTokens": 2048, "responseMimeType": "application/json"}
    });
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let res = reqwest::Client::new()
        .post(&url)
        .query(&[("key", &key)])
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("gemini connect: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("gemini parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("gemini {status}: {body}"));
    }
    body.pointer("/candidates/0/content/parts/0/text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("gemini: no text in response: {body}"))
}

async fn vision_scenes_openai_compat(
    system: &str,
    model: &str,
    base_url: &str,
    key: &str,
    scenes: &[SceneFrameInput],
) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> =
        vec![serde_json::json!({"type": "text", "text": "Here are the scenes in order. Respond as json."})];
    for s in scenes {
        content.push(serde_json::json!({"type": "text", "text": format!("Scene {}: {}", s.index, s.hint)}));
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": {"url": format!("data:image/jpeg;base64,{}", strip_data_url(&s.image))}
        }));
    }
    let req = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.45,
        "max_tokens": 2048
    });
    let res = reqwest::Client::new()
        .post(base_url)
        .header("Authorization", format!("Bearer {}", key.trim()))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("openai connect: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("openai parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("openai {status}: {body}"));
    }
    body.pointer("/choices/0/message/content")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("openai: no content in response: {body}"))
}

async fn vision_scenes_anthropic(
    system: &str,
    model: &str,
    key: &str,
    scenes: &[SceneFrameInput],
) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> =
        vec![serde_json::json!({"type": "text", "text": "Here are the scenes in order. Output only the JSON object."})];
    for s in scenes {
        content.push(serde_json::json!({"type": "text", "text": format!("Scene {}: {}", s.index, s.hint)}));
        content.push(serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": strip_data_url(&s.image)}
        }));
    }
    let req = serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "system": system,
        "messages": [{"role": "user", "content": content}]
    });
    let res = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("anthropic connect: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("anthropic parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("anthropic {status}: {body}"));
    }
    body.pointer("/content/0/text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("anthropic: no text in response: {body}"))
}

fn curator_system_prompt() -> String {
    "You are a sharp video editor reviewing raw footage before a cut. You are shown every scene of one clip IN ORDER, each as a real frame image plus quick stats. \
For EACH scene decide whether to KEEP it or CUT it, judging from the actual image: CUT scenes that are out-of-focus/blurry, badly over- or under-exposed, essentially empty/black, shaky or throwaway, or near-duplicates of a neighbour you already kept. KEEP the sharp, well-exposed, visually interesting and varied shots that make the montage stronger. Be decisive but do NOT cut everything — always keep the strongest shots. \
Return ONLY minified JSON, no prose, no code fences: {\"scenes\":[{\"scene\":<index>,\"keep\":true|false,\"score\":<0..1 quality>,\"reason\":\"<short>\"}]}. One entry per scene, matching its index.".to_string()
}

/// Shared multi-provider vision dispatch: sends the scene frames + a system
/// prompt to the chosen provider's vision model and returns the raw reply text.
async fn run_vision_scenes(
    provider: &str,
    model: &Option<String>,
    api_key: &Option<String>,
    system: &str,
    scenes: &[SceneFrameInput],
) -> Result<String, String> {
    match provider {
        "gemini" | "google" => {
            let k = resolve_key(api_key, "GEMINI_API_KEY")?;
            let m = model.clone().unwrap_or_else(|| "gemini-2.0-flash".into());
            vision_scenes_gemini(system, &m, &k, scenes).await
        }
        "openai" => {
            let k = resolve_key(api_key, "OPENAI_API_KEY")?;
            let m = model.clone().unwrap_or_else(|| "gpt-5.4-mini".into());
            vision_scenes_openai_compat(system, &m, "https://api.openai.com/v1/chat/completions", &k, scenes).await
        }
        "grok" | "xai" => {
            let k = resolve_key(api_key, "XAI_API_KEY")?;
            let m = model.clone().unwrap_or_else(|| "grok-4-latest".into());
            vision_scenes_openai_compat(system, &m, "https://api.x.ai/v1/chat/completions", &k, scenes).await
        }
        "anthropic" | "claude" => {
            let k = resolve_key(api_key, "ANTHROPIC_API_KEY")?;
            let m = model.clone().unwrap_or_else(|| "claude-haiku-4-5".into());
            vision_scenes_anthropic(system, &m, &k, scenes).await
        }
        other => Err(format!("Unknown provider: {}", other)),
    }
}

fn resolve_vision_provider(payload: &GradeScenesRequest) -> String {
    payload
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .or_else(|| {
            payload
                .api_key
                .as_deref()
                .and_then(detect_provider_from_key)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "gemini".into())
}

async fn grade_scenes_handler(
    State(_state): State<AppState>,
    Json(payload): Json<GradeScenesRequest>,
) -> impl IntoResponse {
    if payload.scenes.is_empty() {
        return Json(serde_json::json!({"error": "no scenes provided"})).into_response();
    }
    let provider = resolve_vision_provider(&payload);
    let result = run_vision_scenes(
        &provider,
        &payload.model,
        &payload.api_key,
        &colorist_system_prompt(),
        &payload.scenes,
    )
    .await;
    match result {
        Ok(text) => match extract_json_object(&text) {
            Some(v) => {
                println!("[grade-scenes] provider={} scenes={}", provider, payload.scenes.len());
                Json(v).into_response()
            }
            None => Json(serde_json::json!({"error": "could not parse grades JSON", "raw": text})).into_response(),
        },
        Err(e) => {
            println!("[grade-scenes] provider={} ERROR {}", provider, e);
            Json(serde_json::json!({"error": e})).into_response()
        }
    }
}

async fn curate_scenes_handler(
    State(_state): State<AppState>,
    Json(payload): Json<GradeScenesRequest>,
) -> impl IntoResponse {
    if payload.scenes.is_empty() {
        return Json(serde_json::json!({"error": "no scenes provided"})).into_response();
    }
    let provider = resolve_vision_provider(&payload);
    let result = run_vision_scenes(
        &provider,
        &payload.model,
        &payload.api_key,
        &curator_system_prompt(),
        &payload.scenes,
    )
    .await;
    match result {
        Ok(text) => match extract_json_object(&text) {
            Some(v) => {
                println!("[curate-scenes] provider={} scenes={}", provider, payload.scenes.len());
                Json(v).into_response()
            }
            None => Json(serde_json::json!({"error": "could not parse curation JSON", "raw": text})).into_response(),
        },
        Err(e) => {
            println!("[curate-scenes] provider={} ERROR {}", provider, e);
            Json(serde_json::json!({"error": e})).into_response()
        }
    }
}

async fn agent_step_handler(
    State(_state): State<AppState>,
    Json(payload): Json<AgentStepRequest>,
) -> impl IntoResponse {
    // Provider comes from the request, or is auto-detected from the key format.
    let provider = payload
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .or_else(|| {
            payload
                .api_key
                .as_deref()
                .and_then(detect_provider_from_key)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "gemini".into());

    let result = match provider.as_str() {
        "ollama" | "local" => {
            let model = payload
                .model
                .or(payload.local_model)
                .unwrap_or_else(|| "qwen3.5:9b".into());
            agent_step_ollama(&model, &payload.messages, &payload.tools, payload.api_key.as_deref()).await
        }
        "gemini" | "google" => {
            let key = resolve_key(&payload.api_key, "GEMINI_API_KEY");
            match key {
                Ok(k) => {
                    let model = payload.model.unwrap_or_else(|| "gemini-2.0-flash".into());
                    agent_step_gemini(&model, &k, &payload.messages, &payload.tools).await
                }
                Err(e) => Err(e),
            }
        }
        "openai" => {
            let key = resolve_key(&payload.api_key, "OPENAI_API_KEY");
            match key {
                Ok(k) => {
                    let model = payload.model.unwrap_or_else(|| "gpt-5.4-mini".into());
                    agent_step_openai_compat(
                        &model,
                        "https://api.openai.com/v1/chat/completions",
                        &k,
                        &payload.messages,
                        &payload.tools,
                    )
                    .await
                }
                Err(e) => Err(e),
            }
        }
        "grok" | "xai" => {
            let key = resolve_key(&payload.api_key, "XAI_API_KEY");
            match key {
                Ok(k) => {
                    let model = payload.model.unwrap_or_else(|| "grok-4-latest".into());
                    agent_step_openai_compat(
                        &model,
                        "https://api.x.ai/v1/chat/completions",
                        &k,
                        &payload.messages,
                        &payload.tools,
                    )
                    .await
                }
                Err(e) => Err(e),
            }
        }
        "anthropic" | "claude" => {
            let key = resolve_key(&payload.api_key, "ANTHROPIC_API_KEY");
            match key {
                Ok(k) => {
                    let model = payload.model.unwrap_or_else(|| "claude-haiku-4-5".into());
                    agent_step_anthropic(&model, &k, &payload.messages, &payload.tools).await
                }
                Err(e) => Err(e),
            }
        }
        other => Err(format!("Unknown provider: {}", other)),
    };

    match result {
        Ok(v) => {
            let usage = v.get("usage").cloned().unwrap_or_default();
            println!("[agent-step] provider={} usage={}", provider, usage);
            Json(v).into_response()
        }
        Err(e) => {
            eprintln!("[agent-step] provider={} error={}", provider, e);
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

fn extract_json_block(text: &str) -> Option<serde_json::Value> {
    if let Some(start_idx) = text.find("```") {
        let content_after = &text[start_idx + 3..];
        let content_after = if content_after.starts_with("json") {
            &content_after[4..]
        } else {
            content_after
        };
        if let Some(end_idx) = content_after.find("```") {
            let json_str = content_after[..end_idx].trim();
            if let Ok(v) = serde_json::from_str(json_str) {
                return Some(v);
            }
        }
    }
    if let Some(start_idx) = text.find('{') {
        let mut depth = 0;
        let mut in_str = false;
        let mut esc = false;
        let bytes = text.as_bytes();
        for i in start_idx..bytes.len() {
            let ch = bytes[i] as char;
            if in_str {
                if esc {
                    esc = false;
                } else if ch == '\\' {
                    esc = true;
                } else if ch == '"' {
                    in_str = false;
                }
                continue;
            }
            if ch == '"' {
                in_str = true;
            } else if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    let json_str = &text[start_idx..=i];
                    if let Ok(v) = serde_json::from_str(json_str) {
                        return Some(v);
                    }
                    break;
                }
            }
        }
    }
    None
}

#[derive(serde::Deserialize)]
struct ExtractRecipeRequest {
    url: Option<String>,
    description: Option<String>,
    api_key: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(serde::Serialize)]
struct ExtractRecipeResponse {
    cards: serde_json::Value,
}

async fn extract_recipe_handler(
    State(_state): State<AppState>,
    Json(params): Json<ExtractRecipeRequest>,
) -> impl IntoResponse {
    let mut title = "Custom Video Style".to_string();
    let mut author = "Unknown".to_string();

    let mut visual_analysis = "No direct visual analysis metadata available.".to_string();
    // For the vision path: resolved local video + (scene_index, midpoint, metadata).
    let mut resolved_path: Option<String> = None;
    let mut scene_mids: Vec<(usize, f64, String)> = Vec::new();

    if let Some(ref url) = params.url {
        let is_youtube = url.contains("youtube.com") || url.contains("youtu.be");
        if is_youtube {
            let client = reqwest::Client::new();
            if let Ok(res) = client
                .get("https://www.youtube.com/oembed")
                .query(&[("url", url.as_str()), ("format", "json")])
                .send()
                .await
            {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    if let Some(t) = json.get("title").and_then(|t| t.as_str()) {
                        title = t.to_string();
                    }
                    if let Some(a) = json.get("author_name").and_then(|a| a.as_str()) {
                        author = a.to_string();
                    }
                }
            }
        } else {
            // Local reference file - run Mixpeek-style visual analyzer
            let resolved = resolve_static_path_to_abs(url);
            resolved_path = Some(resolved.clone());
            let client = reqwest::Client::new();
            if let Ok(res) = client
                .post("http://127.0.0.1:8001/api/ai/scene-map")
                .json(&serde_json::json!({
                    "video_path": resolved,
                    "threshold": 27.0
                }))
                .send()
                .await
            {
                if let Ok(json) = res.json::<serde_json::Value>().await {
                    if let Some(scenes) = json.get("scenes").and_then(|s| s.as_array()) {
                        let mut desc = String::new();
                        for (i, s) in scenes.iter().enumerate() {
                            let start = s.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let end = s.get("end").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let tag = s.get("contentTag").and_then(|x| x.as_str()).unwrap_or("scenery");
                            let stats = s.get("colorStats");
                            let brightness = stats.and_then(|x| x.get("brightness")).and_then(|x| x.as_f64()).unwrap_or(0.5);
                            let contrast = stats.and_then(|x| x.get("contrast")).and_then(|x| x.as_f64()).unwrap_or(0.1);
                            let saturation = stats.and_then(|x| x.get("saturation")).and_then(|x| x.as_f64()).unwrap_or(0.1);
                            let warmth = stats.and_then(|x| x.get("warmth")).and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let dominant = stats.and_then(|x| x.get("dominantColors")).and_then(|x| x.as_array())
                                .map(|arr| arr.iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<_>>().join(", "))
                                .unwrap_or_default();
                            
                            desc.push_str(&format!(
                                "- Scene {} ({:.1}s - {:.1}s): tag={}, brightness={:.2}, contrast={:.2}, saturation={:.2}, warmth={:.2}, colors=[{}]\n",
                                i, start, end, tag, brightness, contrast, saturation, warmth, dominant
                            ));
                            scene_mids.push((
                                i,
                                (start + end) / 2.0,
                                format!(
                                    "{:.1}s-{:.1}s tag={} brightness={:.2} contrast={:.2} saturation={:.2} warmth={:.2}",
                                    start, end, tag, brightness, contrast, saturation, warmth
                                ),
                            ));
                        }
                        if !desc.is_empty() {
                            visual_analysis = desc;
                        }
                    }
                }
            }
        }
    }

    let description_val = params.description.clone().unwrap_or_default();
    let prompt = format!(
        "You are an expert video editing and colorist consultant. \
Based on the following reference details and visual frame/color metadata (Mixpeek Extractor), analyze the style, and output a JSON object containing a list of modular preset cards (StyleCards). \
You MUST generate high-quality cards. Avoid generic descriptions. Each card must belong to one of these categories: \
1. 'color': Color grading, HSL values, temperature, contrast, vignette, or lookup tables (LUTs). Must be precise (e.g. specify HSL hue shifts, lift/gamma/gain ranges, or color curves). \
2. 'transitions': Transition kits, whip pan, blur dissolve, crossfade durations (in frames or seconds), or J-cut/L-cut specifications. \
3. 'pacing': Editing tempo, speed ramping, shot duration rhythm (e.g., fast cuts under 1.5s for action, long takes > 5s for dialogue), and beat-syncing. \
4. 'effects': Crop ratios, grain, lens distortion, overlays, or animations. \
You MUST generate at least one 'color' card, one 'transitions' card, and one 'pacing' card. Do NOT group everything into 'effects'. \
Each StyleCard represents a specific, independent aspect of the style. \
If the reference has different visual looks/grades in different scenes (which you can identify from the Scene Breakdown in the Visual Ingest Profile below), you MUST split them into separate 'color' category cards, each with its corresponding 'time_range' bounds (in seconds, e.g. [0.0, 10.0] or [10.0, 25.0]). Otherwise, set 'time_range' to null. \
You MUST format the output as a JSON object matching this schema: \
{{ \
  \"cards\": [ \
    {{ \
      \"category\": \"color\" | \"transitions\" | \"pacing\" | \"effects\", \
      \"name\": \"Name of the preset\", \
      \"time_range\": [start_seconds, end_seconds] or null, \
      \"summary\": \"1-sentence summary of this preset card\", \
      \"recipe_md\": \"Detailed editing instructions in Markdown (.md) format describing exactly how to apply this preset (parameters, speed curves, effect params, aspect ratios, etc.)\" \
    }} \
  ] \
}} \
Ensure only valid JSON is returned in a ```json code block. Write the descriptions and summaries in Vietnamese if the input notes are in Vietnamese, otherwise in English. \
Input Reference Details: \
- Title: {} \
- Creator: {} \
- URL: {} \
- Additional Notes: {} \
- Visual Ingest Profile (Mixpeek Extractor):\n{}",
        title,
        author,
        params.url.as_deref().unwrap_or(""),
        description_val,
        visual_analysis
    );

    let provider = params
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .or_else(|| {
            params
                .api_key
                .as_deref()
                .and_then(detect_provider_from_key)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "gemini".into());

    // Vision path: attach a real frame from each scene so the model SEES the
    // grade / transitions / motion / effects instead of guessing from numbers.
    // Evenly sample up to 12 frames to bound cost and latency.
    let mut scene_frames: Vec<SceneFrameInput> = Vec::new();
    if let Some(ref path) = resolved_path {
        let step = ((scene_mids.len() + 11) / 12).max(1);
        for (idx, mid, meta) in scene_mids.iter().step_by(step) {
            if let Some(img) = extract_frame_b64(path, *mid).await {
                scene_frames.push(SceneFrameInput {
                    index: *idx as i64,
                    image: img,
                    hint: meta.clone(),
                });
            }
        }
    }

    let recipe_result = if !scene_frames.is_empty() {
        let vision_system = format!(
            "{}\n\nIMPORTANT: A real frame from each listed scene is attached as an image, IN ORDER. LOOK at the frames to read the ACTUAL colour grade, the cuts/transitions between shots, camera motion (whip / zoom / push), transforms, letterbox aspect ratio, film grain and other effects. Base every card on what you actually SEE — never on the numbers alone.",
            prompt
        );
        run_vision_scenes(
            &provider,
            &params.model,
            &params.api_key,
            &vision_system,
            &scene_frames,
        )
        .await
        .map(|text| serde_json::json!({ "content": text }))
    } else {
        let messages = serde_json::json!([
            {
                "role": "system",
                "content": "You are a professional video editor and style recipe extractor."
            },
            {
                "role": "user",
                "content": prompt
            }
        ]);
        match provider.as_str() {
            "gemini" | "google" => {
                let key = resolve_key(&params.api_key, "GEMINI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gemini-2.0-flash".into());
                        agent_step_gemini(&model, &k, &messages, &serde_json::json!([])).await
                    }
                    Err(e) => Err(e),
                }
            }
            "openai" => {
                let key = resolve_key(&params.api_key, "OPENAI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gpt-4o-mini".into());
                        agent_step_openai_compat(&model, &k, "https://api.openai.com/v1", &messages, &serde_json::json!([])).await
                    }
                    Err(e) => Err(e),
                }
            }
            "ollama" | "local" => {
                let model = params.model.clone().unwrap_or_else(|| "qwen3.5:9b".into());
                agent_step_ollama(&model, &messages, &serde_json::json!([]), params.api_key.as_deref()).await
            }
            _ => Err(format!("Unsupported provider: {}", provider)),
        }
    };

    match recipe_result {
        Ok(val) => {
            let recipe_text = val.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let json_block = extract_json_block(&recipe_text);
            let cards = json_block
                .and_then(|v| v.get("cards").cloned())
                .unwrap_or_else(|| {
                    let clean_name = if title == "Custom Video Style" && !description_val.is_empty() {
                        if description_val.len() > 25 {
                            format!("{}...", &description_val[0..25])
                        } else {
                            description_val.clone()
                        }
                    } else {
                        title
                    };
                    serde_json::json!([
                        {
                            "category": "effects",
                            "name": clean_name,
                            "time_range": null,
                            "summary": "Extracted editing style guidelines.",
                            "recipe_md": recipe_text
                        }
                    ])
                });

            (
                axum::http::StatusCode::OK,
                Json(ExtractRecipeResponse { cards }),
            )
                .into_response()
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SourceItem {
    id: String,
    #[serde(rename = "type")]
    source_type: String,
    name: String,
    content: String,
    url: Option<String>,
}

#[derive(serde::Deserialize)]
struct SynthesizeSourcesRequest {
    prompt: String,
    sources: Vec<SourceItem>,
    timeline_state: serde_json::Value,
    provider: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

#[derive(serde::Serialize)]
struct SynthesizeSourcesResponse {
    explanation: String,
    cards: serde_json::Value,
}

async fn synthesize_sources_handler(
    State(_state): State<AppState>,
    Json(params): Json<SynthesizeSourcesRequest>,
) -> impl IntoResponse {
    let mut sources_text = String::new();
    for (idx, source) in params.sources.iter().enumerate() {
        sources_text.push_str(&format!(
            "--- SOURCE {} (Name: \"{}\", Type: \"{}\") ---\n{}\n\n",
            idx + 1,
            source.name,
            source.source_type,
            source.content
        ));
    }

    let user_content = format!(
        "=== SOURCE DOCUMENTS ===\n{}\n=== END SOURCE DOCUMENTS ===\n\n\
         === CURRENT TIMELINE STATE ===\n{}\n=== END TIMELINE STATE ===\n\n\
         === USER QUERY/PROMPT ===\n{}\n\n\
         Synthesize the provided source documents and answer the user query based on them. \
         Also generate zero, one, or more modular Preset Cards that can be applied to the timeline. \
         Keep the explanation brief. Output the cards as a JSON block with this schema: \
         {{\"explanation\": \"...\", \"cards\": [ {{\"category\": \"color\"|\"transitions\"|\"pacing\"|\"effects\", \"name\": \"Preset Name\", \"time_range\": [start, end] or null, \"summary\": \"preset summary\", \"recipe_md\": \"markdown recipe\"}} ] }}.",
        sources_text,
        params.timeline_state,
        params.prompt
    );

    let system_prompt = "You are a professional video editor and style synthesis assistant. \
                         Your goal is to extract visual guidelines, pacing rules, transitions, and effects from multiple source materials (NotebookLM style) and translate them into a summary and modular preset cards.";

    let messages = serde_json::json!([
        {
            "role": "system",
            "content": system_prompt
        },
        {
            "role": "user",
            "content": user_content
        }
    ]);

    let provider = params
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .unwrap_or_else(|| "gemini".into());

    let result = match provider.as_str() {
        "gemini" | "google" => {
            let key = resolve_key(&params.api_key, "GEMINI_API_KEY");
            match key {
                Ok(k) => {
                    let model = params.model.clone().unwrap_or_else(|| "gemini-2.0-flash".into());
                    agent_step_gemini(&model, &k, &messages, &serde_json::json!([])).await
                }
                Err(e) => Err(e),
            }
        }
        "openai" => {
            let key = resolve_key(&params.api_key, "OPENAI_API_KEY");
            match key {
                Ok(k) => {
                    let model = params.model.clone().unwrap_or_else(|| "gpt-4o-mini".into());
                    agent_step_openai_compat(&model, &k, "https://api.openai.com/v1", &messages, &serde_json::json!([])).await
                }
                Err(e) => Err(e),
            }
        }
        "ollama" | "local" => {
            let model = params.model.clone().unwrap_or_else(|| "qwen3.5:9b".into());
            agent_step_ollama(&model, &messages, &serde_json::json!([]), params.api_key.as_deref()).await
        }
        _ => Err(format!("Unsupported provider: {}", provider)),
    };

    match result {
        Ok(val) => {
            let text = val.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let json_block = extract_json_block(&text);
            
            let explanation = json_block
                .as_ref()
                .and_then(|v| v.get("explanation").and_then(|e| e.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let mut exp = text.clone();
                    if let Some(start_idx) = exp.find("```") {
                        exp.truncate(start_idx);
                    }
                    exp.trim().to_string()
                });

            let cards = json_block
                .as_ref()
                .and_then(|v| v.get("cards").cloned())
                .unwrap_or_else(|| serde_json::json!([]));

            (
                axum::http::StatusCode::OK,
                Json(SynthesizeSourcesResponse { explanation, cards }),
            )
                .into_response()
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct McpExecuteRequest {
    operations: serde_json::Value,
}

async fn mcp_timeline_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let cache = state.timeline_cache.read().unwrap();
    (
        axum::http::StatusCode::OK,
        cache.clone()
    )
        .into_response()
}

// ─── Notion brief reader ─────────────────────────────────────
// ChronoX pulls an editing brief / script / plan out of Notion so the AI edits
// to the user's intent. Reads a page (by id/url) or searches by query, then
// flattens the blocks to Markdown. Token = a Notion internal integration secret
// (request body, or NOTION_TOKEN in .env).

#[derive(Deserialize, Debug)]
struct NotionBriefRequest {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    page_id: Option<String>,
}

fn notion_extract_id(s: &str) -> String {
    // Accept a raw id or a URL like notion.so/Title-<32hexnodashes>.
    let tail = s.rsplit(['/', '-']).next().unwrap_or(s);
    let hex: String = tail.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]
        )
    } else {
        s.to_string()
    }
}

fn notion_blocks_to_md(results: &[serde_json::Value]) -> String {
    let mut md = String::new();
    for b in results {
        let t = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let rich = b
            .get(t)
            .and_then(|o| o.get("rich_text"))
            .and_then(|r| r.as_array());
        let text = rich
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("plain_text").and_then(|p| p.as_str()))
                    .collect::<String>()
            })
            .unwrap_or_default();
        match t {
            "heading_1" => md.push_str(&format!("# {}\n", text)),
            "heading_2" => md.push_str(&format!("## {}\n", text)),
            "heading_3" => md.push_str(&format!("### {}\n", text)),
            "bulleted_list_item" | "to_do" => md.push_str(&format!("- {}\n", text)),
            "numbered_list_item" => md.push_str(&format!("1. {}\n", text)),
            "quote" => md.push_str(&format!("> {}\n", text)),
            "code" => md.push_str(&format!("```\n{}\n```\n", text)),
            "paragraph" => {
                if text.is_empty() {
                    md.push('\n');
                } else {
                    md.push_str(&format!("{}\n", text));
                }
            }
            _ if !text.is_empty() => md.push_str(&format!("{}\n", text)),
            _ => {}
        }
    }
    md
}

async fn notion_brief_handler(
    State(_state): State<AppState>,
    Json(params): Json<NotionBriefRequest>,
) -> impl IntoResponse {
    let token = match params
        .token
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| std::env::var("NOTION_TOKEN").ok())
    {
        Some(t) => t,
        None => {
            return Json(serde_json::json!({
                "error": "No Notion token: pass `token` or set NOTION_TOKEN in .env (a Notion internal integration secret, and share the page with that integration)."
            }))
            .into_response()
        }
    };
    let client = reqwest::Client::new();
    let ver = "2022-06-28";

    // Resolve the page id: given directly, or search for the top matching page.
    let mut page_id = params.page_id.as_ref().map(|p| notion_extract_id(p));
    let mut title = String::new();
    if page_id.is_none() {
        let q = params.query.clone().unwrap_or_default();
        let res = client
            .post("https://api.notion.com/v1/search")
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Notion-Version", ver)
            .json(&serde_json::json!({
                "query": q,
                "filter": {"property": "object", "value": "page"},
                "page_size": 1
            }))
            .send()
            .await;
        match res {
            Ok(r) => {
                let body: serde_json::Value = r.json().await.unwrap_or_default();
                if let Some(first) = body.pointer("/results/0") {
                    page_id = first.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                    title = first
                        .pointer("/properties/title/title/0/plain_text")
                        .or_else(|| first.pointer("/properties/Name/title/0/plain_text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
            Err(e) => {
                return Json(serde_json::json!({"error": format!("notion search: {e}")})).into_response()
            }
        }
    }
    let pid = match page_id {
        Some(p) => p,
        None => return Json(serde_json::json!({"error": "No matching Notion page found."})).into_response(),
    };

    // Fetch the page's block children and flatten to Markdown.
    let url = format!("https://api.notion.com/v1/blocks/{}/children?page_size=100", pid);
    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Notion-Version", ver)
        .send()
        .await;
    match res {
        Ok(r) => {
            let status = r.status();
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            if !status.is_success() {
                return Json(serde_json::json!({"error": format!("notion {status}: {body}")})).into_response();
            }
            let empty = vec![];
            let results = body.get("results").and_then(|r| r.as_array()).unwrap_or(&empty);
            let markdown = notion_blocks_to_md(results);
            println!("[notion-brief] page={} chars={}", pid, markdown.len());
            Json(serde_json::json!({"page_id": pid, "title": title, "markdown": markdown})).into_response()
        }
        Err(e) => Json(serde_json::json!({"error": format!("notion blocks: {e}")})).into_response(),
    }
}

async fn mcp_execute_handler(
    State(state): State<AppState>,
    Json(params): Json<McpExecuteRequest>,
) -> impl IntoResponse {
    let ws_payload = serde_json::json!({
        "type": "MCP_EXECUTE",
        "payload": {
            "operations": params.operations
        }
    });
    
    let _ = state.mcp_tx.send(ws_payload.to_string());
    
    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({ "status": "success", "message": "operations broadcasted to editor" }))
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct ApplyRecipeRequest {
    recipe: String,
    timeline_state: serde_json::Value,
    tools: Option<serde_json::Value>,
    target_clip_id: Option<String>,
    /// base64 JPEG of the target source clip — lets the model SEE the footage
    /// and tune the technique's parameters to it (vision match-up).
    #[serde(default)]
    target_frame: Option<String>,
    /// Authoritative editor skill recipes for the card's technique(s), retrieved
    /// on the frontend (RAG-ground) so keyframed techniques like zoom/bounce are
    /// built with the documented property paths/presets, not improvised.
    #[serde(default)]
    skills_context: Option<String>,
    api_key: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(serde::Serialize)]
struct ApplyRecipeResponse {
    operations: serde_json::Value,
    explanation: String,
}

async fn apply_recipe_handler(
    State(state): State<AppState>,
    Json(params): Json<ApplyRecipeRequest>,
) -> impl IntoResponse {
    let tools = params.tools.clone().unwrap_or_else(|| serde_json::json!([]));
    let target_msg = if let Some(ref cid) = params.target_clip_id {
        format!("Target Clip ID to apply style: {}", cid)
    } else {
        "Target the entire timeline (or prioritize the active/first video tracks/clips).".to_string()
    };

    // Query episodic memory matching the recipe context (Jaccard similarity search on recipe text)
    let episodic_context = {
        let mut episodic_records = Vec::new();
        {
            let db = state.db.lock().unwrap();
            let stmt_res = db.prepare("SELECT id, timestamp, searchable, situation, decision, reason, confidence, source, status FROM episodic_memory WHERE status = 'active'");
            if let Ok(mut stmt) = stmt_res {
                let records_iter = stmt.query_map((), |row| {
                    let sit_str: String = row.get(3)?;
                    let sit_val: serde_json::Value = serde_json::from_str(&sit_str).unwrap_or(serde_json::Value::Null);
                    Ok(EpisodicMemoryRecord {
                        id: row.get(0)?,
                        timestamp: row.get(1)?,
                        searchable: row.get(2)?,
                        situation: sit_val,
                        decision: row.get(4)?,
                        reason: row.get(5)?,
                        confidence: row.get(6)?,
                        source: row.get(7)?,
                        status: row.get(8)?,
                    })
                });
                if let Ok(iter) = records_iter {
                    for r in iter {
                        if let Ok(rec) = r {
                            episodic_records.push(rec);
                        }
                    }
                }
            }
        }

        let mut matches = Vec::new();
        for rec in episodic_records {
            let score = jaccard_similarity(&params.recipe, &rec.searchable);
            if score > 0.05 {
                matches.push((rec.searchable, rec.situation, rec.decision, rec.reason, score));
            }
        }
        matches.sort_by(|a, b| b.4.partial_cmp(&a.4).unwrap_or(std::cmp::Ordering::Equal));
        
        let mut ctx = String::new();
        for (i, (searchable, situation, decision, reason, _)) in matches.into_iter().take(4).enumerate() {
            let genre = situation.get("genre").or_else(|| situation.get("the_loai")).and_then(|x| x.as_str()).unwrap_or("general");
            ctx.push_str(&format!(
                "- Memory {} (Genre: {}): Context: \"{}\" -> User Decision: {}, Reason: \"{}\"\n",
                i + 1, genre, searchable, decision, reason
            ));
        }
        if ctx.is_empty() {
            "No relevant episodic memories of past user edit corrections found.".to_string()
        } else {
            ctx
        }
    };

    let skills_block = match params.skills_context.as_deref() {
        Some(s) if !s.trim().is_empty() => format!(
            "=== EDITOR SKILL RECIPES (AUTHORITATIVE — for keyframed/transform techniques like zoom/bounce/punch, follow these EXACT property paths, presets, keyframe times and value ranges instead of improvising) ===\n{}\n=== END EDITOR SKILL RECIPES ===\n\n",
            s
        ),
        _ => String::new(),
    };

    let user_content = format!(
        "=== TIMELINE STATE ===\n{}\n=== END TIMELINE STATE ===\n\n\
=== STYLE PRESET RECIPE ===\n{}\n=== END STYLE PRESET RECIPE ===\n\n\
{}\
=== EPISODIC MEMORIES (PAST USER CORRECTIONS) ===\n{}\n=== END EPISODIC MEMORIES ===\n\n\
{}\n\n\
Read the style preset recipe and translate its instructions (color grading, pacing/cuts, transitions, effects/transforms) into concrete editor operations on the targeted clip(s)/timeline. \
MOTION/ANIMATION RULE: for zoom, bounce, punch, push-in, ken-burns, shake, pop-in or any moving effect you MUST emit `upsert_keyframe` operations — one op PER keyframe — never a static `transform` (which sets a fixed value and does NOT animate). \
upsert_keyframe shape: {{\"action\":\"upsert_keyframe\",\"clip_id\":\"<id>\",\"property\":\"scale\"|\"rotate\"|\"x\"|\"y\"|\"opacity\",\"keyframe\":{{\"time\":<seconds from clip start>,\"value\":<number>,\"interpolation\":\"linear\"}}}}. \
Example bounce/punch (scale 1 -> 1.15 -> 1 over 0.25s) = THREE ops: time 0.0 value 1.0, time 0.12 value 1.15, time 0.25 value 1.0 (all property \"scale\"). Example push-in/ken-burns = two scale keyframes across the clip (time 0 value 1.0, time <clip end> value 1.1). Properties animating together must share the same keyframe times. \
Output the JSON block containing the operations: {{\"operations\": [...]}}. Only use valid actions from the schema.",
        params.timeline_state,
        params.recipe,
        skills_block,
        episodic_context,
        target_msg
    );

    let mut system_prompt = SYSTEM_PROMPT.to_string();
    system_prompt.push_str("\n\n=== SPECIAL INSTRUCTION ===\nTranslate the provided Markdown Style Recipe into a sequence of editing operations. Keep the explanation very brief. Output the JSON block containing the operations. If any instruction is not present in your knowledge base (docs/knowledge_base_editing.md), output 'unknown_technique: [name]'.");

    let provider = params
        .provider
        .clone()
        .map(|p| p.to_lowercase())
        .or_else(|| {
            params
                .api_key
                .as_deref()
                .and_then(detect_provider_from_key)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "gemini".into());

    // Vision match-up: if the frontend sent a frame of the target source clip,
    // let the model SEE it and tune the technique to this footage instead of
    // copying the reference blindly. Otherwise fall back to text-only mapping.
    let result = if let Some(frame) = params
        .target_frame
        .as_ref()
        .filter(|f| !f.is_empty())
    {
        let vision_system = format!(
            "{}\n\n{}\n\nThe attached image is a REAL frame from the TARGET source clip you are applying this recipe to. LOOK at it and adapt the technique's parameters (grade strength, effect intensity, transform amount, etc.) to fit THIS source's actual content, lighting and colour — do not copy the reference numbers blindly. Output only {{\"operations\":[...]}}.",
            system_prompt, user_content
        );
        let scenes = vec![SceneFrameInput {
            index: 0,
            image: frame.clone(),
            hint: "the target source clip being edited".into(),
        }];
        run_vision_scenes(&provider, &params.model, &params.api_key, &vision_system, &scenes)
            .await
            .map(|text| serde_json::json!({ "content": text }))
    } else {
        let messages = serde_json::json!([
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ]);
        match provider.as_str() {
            "gemini" | "google" => {
                let key = resolve_key(&params.api_key, "GEMINI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gemini-2.0-flash".into());
                        agent_step_gemini(&model, &k, &messages, &tools).await
                    }
                    Err(e) => Err(e),
                }
            }
            "openai" => {
                let key = resolve_key(&params.api_key, "OPENAI_API_KEY");
                match key {
                    Ok(k) => {
                        let model = params.model.clone().unwrap_or_else(|| "gpt-4o-mini".into());
                        agent_step_openai_compat(&model, &k, "https://api.openai.com/v1", &messages, &tools).await
                    }
                    Err(e) => Err(e),
                }
            }
            "ollama" | "local" => {
                let model = params.model.clone().unwrap_or_else(|| "qwen3.5:9b".into());
                agent_step_ollama(&model, &messages, &tools, params.api_key.as_deref()).await
            }
            _ => Err(format!("Unsupported provider: {}", provider)),
        }
    };

    match result {
        Ok(val) => {
            let text = val.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let json_block = extract_json_block(&text);
            let operations = json_block
                .and_then(|v| v.get("operations").cloned())
                .unwrap_or_else(|| serde_json::json!([]));
                
            let mut explanation = text;
            if let Some(start_idx) = explanation.find("```") {
                explanation.truncate(start_idx);
            }
            explanation = explanation.replace("<thought>", "").replace("</thought>", "").trim().to_string();

            (
                axum::http::StatusCode::OK,
                Json(ApplyRecipeResponse {
                    operations,
                    explanation,
                }),
            )
                .into_response()
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

// ── Ollama API (native tool-calling; canonical format passes through) ──
async fn agent_step_ollama(
    model: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
    api_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({
        "model": model, "messages": messages, "tools": tools,
        "stream": false, "think": false,
        "options": { "temperature": 0.2, "num_ctx": 8192 }
    });
    let client = reqwest::Client::new();
    let base_url = std::env::var("OLLAMA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    
    let mut req = client.post(&url).json(&payload);
    if let Some(key) = api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            req = req.header("Authorization", format!("Bearer {trimmed}"));
        }
    }

    let res = req.send().await.map_err(|e| format!("ollama connect: {e}"))?;
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("ollama parse: {e}"))?;
    let msg = body.get("message").cloned().unwrap_or_default();
    Ok(serde_json::json!({
        "content": msg.get("content").cloned().unwrap_or_else(|| serde_json::json!("")),
        "tool_calls": msg.get("tool_calls").cloned().unwrap_or_else(|| serde_json::json!([])),
        "usage": {
            "input_tokens": body.get("prompt_eval_count").cloned().unwrap_or_else(|| serde_json::json!(0)),
            "output_tokens": body.get("eval_count").cloned().unwrap_or_else(|| serde_json::json!(0)),
        }
    }))
}

// ── OpenAI-compatible (OpenAI + Grok/xAI): canonical format is native ──
async fn agent_step_openai_compat(
    model: &str,
    url: &str,
    key: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({
        "model": model, "messages": messages, "tools": tools,
        "temperature": 0.2, "max_tokens": 1024
    });
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .bearer_auth(key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("{url} {status}: {body}"));
    }
    let msg = body.pointer("/choices/0/message").cloned().unwrap_or_default();
    Ok(serde_json::json!({
        "content": msg.get("content").cloned().unwrap_or_else(|| serde_json::json!("")),
        "tool_calls": msg.get("tool_calls").cloned().unwrap_or_else(|| serde_json::json!([])),
        "usage": {
            "input_tokens": body.pointer("/usage/prompt_tokens").cloned().unwrap_or_else(|| serde_json::json!(0)),
            "output_tokens": body.pointer("/usage/completion_tokens").cloned().unwrap_or_else(|| serde_json::json!(0)),
        }
    }))
}

// ── Google Gemini: full translation both ways ──
async fn agent_step_gemini(
    model: &str,
    key: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1) canonical messages -> Gemini system_instruction + contents
    let empty = vec![];
    let msgs = messages.as_array().unwrap_or(&empty);
    let mut system_text = String::new();
    let mut contents: Vec<serde_json::Value> = Vec::new();
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
                    if !system_text.is_empty() {
                        system_text.push('\n');
                    }
                    system_text.push_str(c);
                }
            }
            "user" => {
                let text = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                contents.push(serde_json::json!({"role":"user","parts":[{"text":text}]}));
            }
            "assistant" => {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = m.get("content").and_then(|c| c.as_str()) {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({"text": t}));
                    }
                }
                if let Some(tcs) = m.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("");
                        let args = normalize_args(
                            tc.pointer("/function/arguments").cloned().unwrap_or_default(),
                        );
                        let mut part = serde_json::json!({
                            "functionCall": {"name": name, "args": args}
                        });
                        if let Some(sig) = tc.get("thought_signature").or_else(|| tc.get("thoughtSignature")) {
                            part["thought_signature"] = sig.clone();
                            part["thoughtSignature"] = sig.clone();
                        }
                        parts.push(part);
                    }
                }
                if parts.is_empty() {
                    parts.push(serde_json::json!({"text": ""}));
                }
                contents.push(serde_json::json!({"role":"model","parts":parts}));
            }
            "tool" => {
                let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let content = m.get("content").cloned().unwrap_or_default();
                let tool_call_id = m.get("tool_call_id").and_then(|id| id.as_str()).unwrap_or("");
                
                // Find matching thought_signature from conversation history
                let mut found_signature = None;
                for prev in msgs {
                    if prev.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                        if let Some(tcs) = prev.get("tool_calls").and_then(|t| t.as_array()) {
                            for tc in tcs {
                                let tc_id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                let tc_name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("");
                                if (tc_id == tool_call_id && !tool_call_id.is_empty()) || (tc_name == name && tool_call_id.is_empty()) {
                                    if let Some(sig) = tc.get("thought_signature").or_else(|| tc.get("thoughtSignature")) {
                                        found_signature = Some(sig.clone());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if found_signature.is_some() {
                        break;
                    }
                }

                let mut part = serde_json::json!({
                    "functionResponse": {
                        "name": name,
                        "response": {"result": content}
                    }
                });
                if let Some(sig) = found_signature {
                    part["thought_signature"] = sig.clone();
                    part["thoughtSignature"] = sig;
                }

                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [part]
                }));
            }
            _ => {}
        }
    }

    // 2) canonical tools -> Gemini function_declarations (unwrap `.function`)
    let mut decls: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = tools.as_array() {
        for t in arr {
            let f = t.get("function").cloned().unwrap_or_else(|| t.clone());
            let name = f.get("name").cloned().unwrap_or_else(|| serde_json::json!("tool"));
            let desc = f.get("description").cloned().unwrap_or_else(|| serde_json::json!(""));
            let params = sanitize_gemini_schema(f.get("parameters").cloned().unwrap_or_default());
            let has_props = params
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|o| !o.is_empty())
                .unwrap_or(false);
            let mut decl = serde_json::json!({"name": name, "description": desc});
            if has_props {
                decl["parameters"] = params;
            }
            decls.push(decl);
        }
    }

    let mut req = serde_json::json!({
        "contents": contents,
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1024}
    });
    if !decls.is_empty() {
        req["tools"] = serde_json::json!([{"function_declarations": decls}]);
    }
    if !system_text.is_empty() {
        req["system_instruction"] = serde_json::json!({"parts":[{"text": system_text}]});
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .query(&[("key", &key)])
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("gemini connect: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("gemini parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("gemini {status}: {body}"));
    }

    // 3) Gemini candidate parts -> canonical content + tool_calls
    let mut content = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    if let Some(parts) = body
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
    {
        for (i, p) in parts.iter().enumerate() {
            if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                content.push_str(t);
            }
            if let Some(fc) = p.get("functionCall") {
                let name = fc.get("name").cloned().unwrap_or_default();
                let args = fc.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
                let thought_signature = p.get("thought_signature")
                    .or_else(|| p.get("thoughtSignature"))
                    .or_else(|| fc.get("thought_signature"))
                    .or_else(|| fc.get("thoughtSignature"))
                    .cloned();
                let mut tool_call = serde_json::json!({
                    "id": format!("call_{}", i),
                    "type": "function",
                    "function": {"name": name, "arguments": args}
                });
                if let Some(sig) = thought_signature {
                    tool_call["thought_signature"] = sig;
                }
                tool_calls.push(tool_call);
            }
        }
    }
    Ok(serde_json::json!({
        "content": content,
        "tool_calls": tool_calls,
        "usage": {
            "input_tokens": body.pointer("/usageMetadata/promptTokenCount").cloned().unwrap_or_else(|| serde_json::json!(0)),
            "output_tokens": body.pointer("/usageMetadata/candidatesTokenCount").cloned().unwrap_or_else(|| serde_json::json!(0)),
        }
    }))
}

// ── Anthropic Claude: Messages API tool-use translation both ways ──
async fn agent_step_anthropic(
    model: &str,
    key: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1) canonical messages -> Anthropic system + messages (tool_use/tool_result blocks)
    let empty = vec![];
    let msgs = messages.as_array().unwrap_or(&empty);
    let mut system_text = String::new();
    let mut out_msgs: Vec<serde_json::Value> = Vec::new();
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
                    if !system_text.is_empty() {
                        system_text.push('\n');
                    }
                    system_text.push_str(c);
                }
            }
            "user" => {
                let text = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                out_msgs.push(serde_json::json!({"role":"user","content":text}));
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = m.get("content").and_then(|c| c.as_str()) {
                    if !t.is_empty() {
                        blocks.push(serde_json::json!({"type":"text","text":t}));
                    }
                }
                if let Some(tcs) = m.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("call_0");
                        let name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("");
                        let input = normalize_args(
                            tc.pointer("/function/arguments").cloned().unwrap_or_default(),
                        );
                        blocks.push(serde_json::json!({
                            "type":"tool_use","id":id,"name":name,"input":input
                        }));
                    }
                }
                if !blocks.is_empty() {
                    out_msgs.push(serde_json::json!({"role":"assistant","content":blocks}));
                }
            }
            "tool" => {
                let id = m
                    .get("tool_call_id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("call_0");
                let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                out_msgs.push(serde_json::json!({
                    "role":"user",
                    "content":[{"type":"tool_result","tool_use_id":id,"content":content}]
                }));
            }
            _ => {}
        }
    }

    // 2) canonical tools -> Anthropic {name, description, input_schema}
    let mut a_tools: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = tools.as_array() {
        for t in arr {
            let f = t.get("function").cloned().unwrap_or_else(|| t.clone());
            a_tools.push(serde_json::json!({
                "name": f.get("name").cloned().unwrap_or_else(|| serde_json::json!("tool")),
                "description": f.get("description").cloned().unwrap_or_else(|| serde_json::json!("")),
                "input_schema": f.get("parameters").cloned()
                    .unwrap_or_else(|| serde_json::json!({"type":"object","properties":{}})),
            }));
        }
    }

    let mut req = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": out_msgs,
        "tools": a_tools,
    });
    if !system_text.is_empty() {
        req["system"] = serde_json::json!(system_text);
    }

    let client = reqwest::Client::new();
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("anthropic connect: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("anthropic parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("anthropic {status}: {body}"));
    }

    // 3) Anthropic content blocks -> canonical content + tool_calls
    let mut content = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    if let Some(blocks) = body.get("content").and_then(|c| c.as_array()) {
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        content.push_str(t);
                    }
                }
                Some("tool_use") => {
                    tool_calls.push(serde_json::json!({
                        "id": b.get("id").cloned().unwrap_or_default(),
                        "type": "function",
                        "function": {
                            "name": b.get("name").cloned().unwrap_or_default(),
                            "arguments": b.get("input").cloned().unwrap_or_else(|| serde_json::json!({}))
                        }
                    }));
                }
                _ => {}
            }
        }
    }
    Ok(serde_json::json!({
        "content": content,
        "tool_calls": tool_calls,
        "usage": {
            "input_tokens": body.pointer("/usage/input_tokens").cloned().unwrap_or_else(|| serde_json::json!(0)),
            "output_tokens": body.pointer("/usage/output_tokens").cloned().unwrap_or_else(|| serde_json::json!(0)),
        }
    }))
}

// ─── Worker proxies: transcribe + beat detection (resolve /static paths) ──
#[derive(Deserialize)]
struct TranscribeProxyRequest {
    audio_path: String,
    #[serde(default)]
    language: Option<String>,
}

async fn ai_transcribe_handler(
    Json(payload): Json<TranscribeProxyRequest>,
) -> impl IntoResponse {
    let resolved = resolve_static_path_to_abs(&payload.audio_path);
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "audio_path": resolved, "language": payload.language });
    match client
        .post("http://127.0.0.1:8001/api/ai/transcribe")
        .json(&body)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
    {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("transcribe parse: {e}"),
            )
                .into_response(),
        },
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("worker connect: {e}"),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct BeatsProxyRequest {
    audio_path: String,
    #[serde(default)]
    mode: Option<String>,
}

async fn ai_detect_beats_handler(
    Json(payload): Json<BeatsProxyRequest>,
) -> impl IntoResponse {
    let resolved = resolve_static_path_to_abs(&payload.audio_path);
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "audio_path": resolved,
        "mode": payload.mode.unwrap_or_else(|| "beat".into())
    });
    match client
        .post("http://127.0.0.1:8001/api/ai/detect-beats")
        .json(&body)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
    {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("beats parse: {e}"),
            )
                .into_response(),
        },
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("worker connect: {e}"),
        )
            .into_response(),
    }
}

// ─── Provider detection + model listing (for the in-app key UI) ─────────
// The user pastes an API key in the app. The key FORMAT is only a shortcut:
// if the prefix is recognized we go straight to that vendor; otherwise we
// PROBE every vendor's list-models endpoint with the key and use whichever
// accepts it. Format never hard-blocks a key.
#[derive(Deserialize)]
struct ProviderModelsRequest {
    #[serde(default)]
    api_key: Option<String>,
}

/// Validate a key against one vendor by listing its models.
async fn list_models_for(provider: &str, key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    match provider {
        "ollama" => {
            let base_url = std::env::var("OLLAMA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
            let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
            let mut req = client.get(&url);
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                req = req.header("Authorization", format!("Bearer {trimmed}"));
            }
            let body: serde_json::Value = req
                .send()
                .await
                .map_err(|e| format!("Ollama endpoint error: {e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            Ok(body
                .get("models")
                .and_then(|m| m.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default())
        }
        "gemini" => {
            let body: serde_json::Value = client
                .get("https://generativelanguage.googleapis.com/v1beta/models")
                .query(&[("key", key), ("pageSize", "100")])
                .send()
                .await
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            if let Some(err) = body.get("error") {
                return Err(format!("Gemini rejected the key: {err}"));
            }
            let mut models: Vec<String> = body
                .get("models")
                .and_then(|m| m.as_array())
                .map(|a| {
                    a.iter()
                        .filter(|m| {
                            m.get("supportedGenerationMethods")
                                .and_then(|s| s.as_array())
                                .map(|s| s.iter().any(|v| v.as_str() == Some("generateContent")))
                                .unwrap_or(false)
                        })
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                        .map(|n| n.trim_start_matches("models/").to_string())
                        .collect()
                })
                .unwrap_or_default();
            models.sort_by(|a, b| b.cmp(a)); // newest-ish first
            Ok(models)
        }
        "openai" | "grok" => {
            let url = if provider == "openai" {
                "https://api.openai.com/v1/models"
            } else {
                "https://api.x.ai/v1/models"
            };
            let res = client
                .get(url)
                .bearer_auth(key)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("{provider} rejected the key ({status})"));
            }
            let mut models: Vec<String> = body
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                        .filter(|id| {
                            provider != "openai"
                                || (id.starts_with("gpt-") || id.starts_with("o"))
                        })
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            models.sort_by(|a, b| b.cmp(a));
            Ok(models)
        }
        "anthropic" => {
            let res = client
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("Claude rejected the key ({status})"));
            }
            Ok(body
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default())
        }
        other => Err(format!("Unknown provider: {other}")),
    }
}

async fn provider_models_handler(
    Json(payload): Json<ProviderModelsRequest>,
) -> impl IntoResponse {
    let key = payload.api_key.unwrap_or_default();
    let key = key.trim().to_string();

    // Fast path: recognized key format → ask that vendor directly.
    if let Some(provider) = detect_provider_from_key(&key) {
        return match list_models_for(provider, &key).await {
            Ok(models) if !models.is_empty() => {
                Json(serde_json::json!({"provider": provider, "models": models})).into_response()
            }
            Ok(_) => (
                axum::http::StatusCode::BAD_REQUEST,
                format!("{provider} accepted the key but returned no models"),
            )
                .into_response(),
            Err(e) => (axum::http::StatusCode::BAD_REQUEST, e).into_response(),
        };
    }

    // Unknown format → probe every vendor with the key; first one that
    // accepts it wins. Format is a hint, never a gate.
    let mut failures: Vec<String> = Vec::new();
    for provider in ["gemini", "openai", "anthropic", "grok"] {
        match list_models_for(provider, &key).await {
            Ok(models) if !models.is_empty() => {
                println!("[provider-models] probe matched: {provider}");
                return Json(serde_json::json!({
                    "provider": provider,
                    "models": models,
                    "detected_by": "probe"
                }))
                .into_response();
            }
            Ok(_) => failures.push(format!("{provider}: 0 model")),
            Err(e) => failures.push(e),
        }
    }
    (
        axum::http::StatusCode::BAD_REQUEST,
        format!(
            "No vendor accepted this key — it may not be an API key. \
             Gemini: get an AIza… key at aistudio.google.com/apikey. Details: {}",
            failures.join(" | ")
        ),
    )
        .into_response()
}

// Coerce a tool_call `arguments` that may be a JSON-string into an object.
fn normalize_args(v: serde_json::Value) -> serde_json::Value {
    if let serde_json::Value::String(s) = &v {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(s) {
            return parsed;
        }
    }
    v
}

// Gemini accepts an OpenAPI-subset schema; strip keys it rejects.
fn sanitize_gemini_schema(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                if matches!(
                    k.as_str(),
                    "additionalProperties" | "$schema" | "default" | "examples" | "title"
                ) {
                    continue;
                }
                out.insert(k, sanitize_gemini_schema(val));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(sanitize_gemini_schema).collect())
        }
        other => other,
    }
}

// Minimal .env loader (KEY=VALUE per line, # comments) — avoids a dotenvy dep.
fn load_dotenv() {
    let Ok(text) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
    }
}

#[derive(Deserialize)]
struct TrackRequest {
    media_id: String,
    points: serde_json::Value,
    brush_size: f64,
    keyframe_time: f64,
    clip_start: f64,
    clip_duration: f64,
}

async fn ai_track_handler(
    Json(params): Json<TrackRequest>,
) -> impl IntoResponse {
    let proxy_path = format!("./shared_storage/{}_proxy.mp4", params.media_id);
    let abs_proxy_path = match std::fs::canonicalize(&proxy_path) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => {
            if let Ok(curr) = std::env::current_dir() {
                curr.join(&proxy_path).to_string_lossy().to_string()
            } else {
                proxy_path
            }
        }
    };

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "video_path": abs_proxy_path,
        "points": params.points,
        "brush_size": params.brush_size,
        "keyframe_time": params.keyframe_time,
        "clip_start": params.clip_start,
        "clip_duration": params.clip_duration,
    });

    match client
        .post("http://127.0.0.1:8001/api/ai/track-brush")
        .json(&payload)
        .send()
        .await
    {
        Ok(res) => {
            if let Ok(body) = res.json::<serde_json::Value>().await {
                Json(body).into_response()
            } else {
                (axum::http::StatusCode::BAD_GATEWAY, "Invalid JSON response from AI worker").into_response()
            }
        }
        Err(e) => {
            (axum::http::StatusCode::BAD_GATEWAY, format!("AI worker unreachable: {}", e)).into_response()
        }
    }
}
