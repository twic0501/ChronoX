use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
pub struct FlatElement {
    pub id: String,
    pub start_time: f64,
    pub duration: f64,
    pub track_index: u32,
}

#[derive(Serialize, Deserialize)]
pub struct FlatPosition {
    pub id: String,
    pub left: f64,
    pub width: f64,
    pub track_index: u32,
}

#[wasm_bindgen]
pub fn calculate_element_positions(val: JsValue, px_per_sec: f64) -> JsValue {
    // Deserialize the flat elements list from Javascript using serde-wasm-bindgen
    let elements: Vec<FlatElement> = match serde_wasm_bindgen::from_value(val) {
        Ok(el) => el,
        Err(_) => return JsValue::NULL,
    };
    
    let mut positions = Vec::with_capacity(elements.len());
    
    // Calculate the left offset and width in pixels for each timeline element
    for el in elements {
        positions.push(FlatPosition {
            id: el.id,
            left: el.start_time * px_per_sec,
            width: el.duration * px_per_sec,
            track_index: el.track_index,
        });
    }

    // Serialize the layout coordinates back to Javascript objects
    serde_wasm_bindgen::to_value(&positions).unwrap_or(JsValue::NULL)
}
