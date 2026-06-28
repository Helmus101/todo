import { Composio } from "composio-core";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  const sdk = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  console.log("Testing composio SDK");
}
run();
