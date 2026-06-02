#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkBudget, waitUntilBudgetRefresh } from "./mcp-tools.mjs";

const agentSchema = z.enum(["claude", "codex"]).optional();

function jsonResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: "codex-budget-guard",
  version: "0.1.0"
});

server.registerTool(
  "check_budget",
  {
    title: "Check Budget",
    description: "Return normalized budget utilization JSON for Claude or Codex.",
    inputSchema: {
      agent: agentSchema
    }
  },
  async (args) => jsonResult(await checkBudget(args))
);

server.registerTool(
  "wait_until_budget_refresh",
  {
    title: "Wait Until Budget Refresh",
    description: "Block until budget utilization drops below the requested threshold.",
    inputSchema: {
      agent: agentSchema,
      resume_below: z.number().min(0).max(100).optional(),
      poll_seconds: z.number().min(0).optional(),
      max_wait_seconds: z.number().min(0).optional()
    }
  },
  async (args) => jsonResult(await waitUntilBudgetRefresh(args))
);

await server.connect(new StdioServerTransport());
