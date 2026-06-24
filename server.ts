import express from "express";
import path from "path";
import dns from "dns";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import apiApp from "./api/index.js";

// Load environment variables
dotenv.config();

// Ensure Node standardizes to IPv4 first to avoid localhost lookup latency
dns.setDefaultResultOrder("ipv4first");

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Mount API routes from the separated module for Vercel
  app.use(apiApp);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Srade Operating Server running on port ${PORT}`);
  });
}

startServer();
