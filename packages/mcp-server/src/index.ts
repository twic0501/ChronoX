#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk";

const BACKEND_URL = process.env.CHRONOX_BACKEND_URL || "http://127.0.0.1:8000";

const server = new Server(
  {
    name: "chronox-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_clips",
        description: "List all active video and audio clips currently loaded on the editor timeline with their ids, times, and tracks.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "execute_operations",
        description: "Execute a sequence of video editing operations (split, trim, delete, adjust_color, retime, effects) directly on the timeline.",
        inputSchema: {
          type: "object",
          properties: {
            operations: {
              type: "array",
              description: "Array of operations matching the ChronoX NLE schema.",
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["trim", "split", "delete", "adjust_color", "retime", "add_effect", "adjust_volume"],
                  },
                  clip_id: { type: "string" },
                  time: { type: "number" },
                  start: { type: "number" },
                  end: { type: "number" },
                  rate: { type: "number" },
                  params: { type: "object" },
                },
                required: ["action"],
              },
            },
          },
          required: ["operations"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_clips") {
      const res = await fetch(`${BACKEND_URL}/api/mcp/timeline`);
      if (!res.ok) {
        throw new Error(`Rust core backend returned error: ${res.statusText}`);
      }
      const data = await res.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }

    if (name === "execute_operations") {
      const operations = (args as any)?.operations || [];
      const res = await fetch(`${BACKEND_URL}/api/mcp/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations }),
      });
      if (!res.ok) {
        throw new Error(`Rust core backend execution failed: ${res.statusText}`);
      }
      const data = await res.json() as any;
      return {
        content: [
          {
            type: "text",
            text: `Successfully sent ${operations.length} operations to editor: ${data.message || "queued"}`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error executing tool: ${err.message}`,
        },
      ],
    };
  }
});

// Start transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ChronoX MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP Server:", err);
  process.exit(1);
});
