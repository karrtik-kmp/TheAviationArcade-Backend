import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env itself. Node 22+ can.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: DATABASE_URL must come from the real environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
