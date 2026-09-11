import process from "node:process";
import { MatchiClient } from "../src/matchi-client.mjs";

const client = new MatchiClient();
await client.login(process.env.MATCHI_EMAIL, process.env.MATCHI_PASSWORD, "/profile/home");
const cards = await client.getProfileValueCards();
console.log(JSON.stringify({ count: cards.length, cards }, null, 2));
