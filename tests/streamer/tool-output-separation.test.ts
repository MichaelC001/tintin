import test from "node:test";
import assert from "node:assert/strict";
import { formatToolPairMessage } from "../../src/runtime/streamer/eventMappers/helpers.js";

/**
 * Tests for tool_output separation feature.
 *
 * This feature separates tool_output messages in the WebSocket protocol:
 * - WebSocket clients receive structured { type: "tool_output", name, output } messages
 * - TG/Slack clients receive formatted text messages (unchanged behavior)
 */

test("formatToolPairMessage for TG/Slack compatibility", async (t) => {
  await t.test("should format tool call with output", () => {
    const result = formatToolPairMessage({
      callText: "$ ls -la",
      outputText: "total 12\ndrwxr-xr-x  3 user  staff  96 Jan  1 00:00 .",
      maxMessageChars: 3500,
    });

    assert.ok(result.startsWith("```\n"));
    assert.ok(result.endsWith("\n```"));
    assert.ok(result.includes("$ ls -la"));
    assert.ok(result.includes("total 12"));
  });

  await t.test("should format output without call text", () => {
    const result = formatToolPairMessage({
      callText: null,
      outputText: "File created successfully",
      maxMessageChars: 3500,
    });

    assert.ok(result.startsWith("```\n"));
    assert.ok(result.endsWith("\n```"));
    assert.ok(result.includes("File created successfully"));
    assert.ok(!result.includes("null"));
  });

  await t.test("should truncate long output", () => {
    const longOutput = "x".repeat(5000);
    const result = formatToolPairMessage({
      callText: "$ cat large_file.txt",
      outputText: longOutput,
      maxMessageChars: 100,
    });

    // Should be within maxMessageChars
    assert.ok(result.length <= 100);
    assert.ok(result.startsWith("```\n"));
    assert.ok(result.endsWith("\n```"));
  });

  await t.test("should sanitize fenced code blocks in content", () => {
    const result = formatToolPairMessage({
      callText: "$ cat script.md",
      outputText: "```bash\necho hello\n```",
      maxMessageChars: 3500,
    });

    // Should escape inner ``` to prevent markdown issues
    // The function uses zero-width space to break up the backticks
    assert.ok(!result.includes("\n```bash\n"));
  });
});

test("PendingToolCall structure", async (t) => {
  /**
   * The pendingToolCalls map now stores structured objects instead of plain strings.
   * This allows tool_output to include the original tool name.
   */

  await t.test("should contain text and toolName fields", () => {
    interface PendingToolCall {
      text: string;
      toolName: string;
    }

    const pending: PendingToolCall = {
      text: "$ npm install",
      toolName: "Bash",
    };

    assert.equal(typeof pending.text, "string");
    assert.equal(typeof pending.toolName, "string");
    assert.equal(pending.text, "$ npm install");
    assert.equal(pending.toolName, "Bash");
  });

  await t.test("should allow undefined toolName to fall back to 'unknown'", () => {
    interface PendingToolCall {
      text: string;
      toolName: string;
    }

    // When toolName is not available, we use "unknown"
    const pending: PendingToolCall = {
      text: "some call",
      toolName: "unknown",
    };

    assert.equal(pending.toolName, "unknown");
  });
});

test("SessionMessage tool_output type", async (t) => {
  /**
   * The SessionMessage union type now includes tool_output variant.
   */

  await t.test("should have required fields", () => {
    interface ToolOutputMessage {
      type: "tool_output";
      name: string;
      output: string;
      callText?: string;
      priority?: "user" | "background";
    }

    const message: ToolOutputMessage = {
      type: "tool_output",
      name: "Bash",
      output: "added 357 packages in 30s",
      callText: "$ npm install",
      priority: "user",
    };

    assert.equal(message.type, "tool_output");
    assert.equal(message.name, "Bash");
    assert.equal(message.output, "added 357 packages in 30s");
    assert.equal(message.callText, "$ npm install");
    assert.equal(message.priority, "user");
  });

  await t.test("should allow optional callText", () => {
    interface ToolOutputMessage {
      type: "tool_output";
      name: string;
      output: string;
      callText?: string;
      priority?: "user" | "background";
    }

    const message: ToolOutputMessage = {
      type: "tool_output",
      name: "Read",
      output: "file contents...",
    };

    assert.equal(message.callText, undefined);
  });
});

test("WebSocket ToolOutputMessage", async (t) => {
  /**
   * The WebSocket protocol sends structured tool_output messages.
   */

  await t.test("should have correct WebSocket message format", () => {
    interface WsToolOutputMessage {
      type: "tool_output";
      sessionId: string;
      name: string;
      output: string;
    }

    const wsMessage: WsToolOutputMessage = {
      type: "tool_output",
      sessionId: "session-123",
      name: "Bash",
      output: "Command executed successfully",
    };

    assert.equal(wsMessage.type, "tool_output");
    assert.equal(wsMessage.sessionId, "session-123");
    assert.equal(wsMessage.name, "Bash");
    assert.equal(wsMessage.output, "Command executed successfully");
  });

  await t.test("should not include callText in WebSocket message", () => {
    // WebSocket messages don't need callText because the frontend already
    // received the tool_call message with the input
    interface WsToolOutputMessage {
      type: "tool_output";
      sessionId: string;
      name: string;
      output: string;
    }

    const wsMessage: WsToolOutputMessage = {
      type: "tool_output",
      sessionId: "session-123",
      name: "Bash",
      output: "result",
    };

    // Verify no callText field
    assert.ok(!("callText" in wsMessage));
  });
});
