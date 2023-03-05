import { TextMessage, WebhookEvent } from "@line/bot-sdk";
import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  QUEUE: Queue;
  CHANNEL_ACCESS_TOKEN: string;
  CHANNEL_SECRET: string;
  OPENAI_API_KEY: string;
};

type Role = "user" | "system" | "assistant";

type RequestBody = {
  events: WebhookEvent[];
};

type QueueData = {
  userId: string;
  content: string;
  replyToken: string;
};

type QueueMessage = {
  body: QueueData;
  timestamp: string;
  id: string;
};

type ChatGPTRequestMessage = {
  role: Role;
  content: string;
};

type ChatGPTResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  usage: {
    prompt_token: number;
    completion_token: number;
    total_tokens: number;
  };
  choices: {
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string;
    index: number;
  }[];
};

const app = new Hono<{ Bindings: Bindings }>();

app.post("/api/webhook", async (c) => {
  // Extract From Request Body
  const data = await c.req.json<RequestBody>();
  const event = data.events[0];
  if (event.type !== "message" || event.message.type !== "text") {
    return new Response("body error", { status: 400 });
  }
  const { source, replyToken } = event;
  if (source.type !== "user") {
    return new Response("body error", { status: 400 });
  }
  const { userId } = source;
  const { text } = event.message;
  const queueData = {
    userId,
    content: text,
    replyToken,
  };
  await c.env.QUEUE.send(queueData);
  return c.json({ message: "ok" });
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<Error>, env: Bindings): Promise<void> {
    let messages = JSON.stringify(batch.messages);
    const queueMessages = JSON.parse(messages) as QueueMessage[];
    for await (const message of queueMessages) {
      const { userId, content, replyToken } = message.body;
      // DBに登録する
      await env.DB.prepare(
        `insert into messages(user_id, role, content) values (?, "user", ?)`
      )
        .bind(userId, content)
        .run();
      // DBを参照する
      const { results } = await env.DB.prepare(
        `select role, content from messages where user_id = ?1 order by id`
      )
        .bind(userId)
        .all<ChatGPTRequestMessage>();
      const chatGPTcontents = results ?? [];
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "post",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: chatGPTcontents,
          }),
        });
        const body = await res.json<ChatGPTResponse>();
        // DBに登録する
        await env.DB.prepare(
          `insert into messages(user_id, role, content) values (?, "assistant", ?)`
        )
          .bind(userId, body.choices[0].message.content)
          .run();
        const accessToken: string = env.CHANNEL_ACCESS_TOKEN;
        const response: TextMessage = {
          type: "text",
          text: body.choices[0].message.content,
        };
        await fetch("https://api.line.me/v2/bot/message/reply", {
          body: JSON.stringify({
            replyToken: replyToken,
            messages: [response],
          }),
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error);
        }
      }
    }
  },
};
