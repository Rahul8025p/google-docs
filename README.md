# Collaborative Editor – Deployment Guide

## Overview
This repository contains a **real‑time collaborative editor** built with Node.js, WebSockets, OT, and a full production‑ready DevOps stack.

The guide below shows how to:
1. **Run locally** (Docker Compose). 
2. **Expose a public URL** (ngrok, Cloudflare Tunnel, or a cloud platform). 
3. **Deploy for free** on popular PaaS providers – Railway, Render, Fly.io.
4. **Keep the service running continuously**.
5. **Monitor** with Prometheus + Grafana.

---

## 1️⃣ Local Development (Docker Compose)
```bash
# Clone the repo and cd into it
git clone <YOUR_REPO_URL>
cd Google-Docs

# Copy the example env file and edit if needed
cp .env.example .env

# Build and start all services
docker compose up -d --scale app=3   # 3 Node.js instances for scaling demo
```
- The editor UI is reachable at `http://localhost` (port 80 is mapped to NGINX). 
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` (login: **admin / admin** – change password!).

### Stopping
```bash
docker compose down
```
---

## 2️⃣ Public URL — Any‑where Access
| Method | Description | Cost | When to use |
|--------|-------------|------|-------------|
| **ngrok** (free tier) | Starts a tunnel to `localhost:80` and gives you a temporary `https://xxxxx.ngrok.io` URL. | Free (limited hours) | Quick demo, testing on mobile devices. |
| **Cloudflare Tunnel** | `cloudflared tunnel run` creates a stable sub‑domain under `*.trycloudflare.com`. | Free | Persistent URL without needing a cloud account. |
| **PaaS deployment** (Railway/Render/Fly) | The platform provisions a public domain (`your-app.up.railway.app`, `your-app.onrender.com`, `your-app.fly.dev`). | Free tier provides a few hundred hours/month – more than enough for demos. | Production‑like showcase, continuous uptime. |

### Example – ngrok
```bash
# Install ngrok (Windows - download from ngrok.com)
ngrok http 80
```
Copy the `https://…ngrok.io` URL and share it – the tunnel forwards all traffic (HTTP & WS) to your local NGINX, which load‑balances the three Node.js instances.

---

## 3️⃣ Free Cloud Platforms (One‑Click Deploy)
All three platforms can directly read the `Dockerfile` and `docker-compose.yml` you already have.

### 3.1 Railway
1. Sign‑up at <https://railway.app> (free tier). 
2. Click **New Project → Deploy from Repo** and connect your GitHub repo.
3. Railway auto‑detects the `Dockerfile`. Add the following **environment variables** (via the UI):
   - `PORT=80`
   - `NODE_ENV=production`
   - `MAX_CONNECTIONS=1000`
   - `ALLOWED_ORIGINS=*`
   - (`MONGODB_URI`, `REDIS_URL`, `KAFKA_BROKERS` if you enable those services – see optional sections below).
4. Railway builds the image, starts the container, and gives you a public URL (`https://<your‑app>.railway.app`).

### 3.2 Render
1. Create an account at <https://render.com>. 
2. New **Web Service** → **Docker** → select your repo.
3. Set **Build Command** to `docker compose build` and **Start Command** to `docker compose up -d --scale app=3`.
4. Add the same env vars in the **Environment** tab.
5. Render provisions a URL (`https://<your‑app>.onrender.com`).

### 3.3 Fly.io
1. Install the Fly CLI (`curl -L https://fly.io/install.sh | sh`).
2. `fly launch` inside the repo directory.
   - Choose **Dockerfile** when prompted.
   - Set **app name** (`my-collab-editor`).
3. After launch, edit `fly.toml` (created automatically) to scale the app:
   ```toml
   [services]
   [[services.ports]]
     port = 80
     handlers = ["http"]
   [[services.concurrency]]
     type = "connections"
     soft_limit = 1000
   [[services.http_checks]]
     interval = "30s"
   ```
4. `fly secrets set NODE_ENV=production MAX_CONNECTIONS=1000` etc.
5. `fly deploy` – Fly gives you `https://my-collab-editor.fly.dev`.

All three providers keep the container **running continuously** (they restart it automatically on crashes). Your free tier should be sufficient for a demo with a few concurrent users.
---

## 4️⃣ Optional Add‑Ons (showcasing more system‑design concepts)
| Feature | Service | Free Tier | How to enable |
|---------|---------|-----------|--------------|
| **Redis (Pub/Sub)** | Fly.io Redis, Railway Redis, Render Redis | 256 MiB | Add a Redis managed service, set `REDIS_URL` env var, update `server.js` to use both `pubClient` and `subClient` (already in code). |
| **Kafka‑compatible streaming** | **Redpanda (Self‑hosted)** – runs as another Docker service in `docker‑compose.yml`. | Free (single‑node) | `docker compose up -d redpanda` and set `KAFKA_BROKERS=redpanda:9092` env var. |
| **MongoDB persistence** | MongoDB Atlas (free tier) | Free (512 MiB) | Add `MONGODB_URI` env var and modify `server.js` to store document snapshots. |
| **Metrics & Alerts** | Prometheus + Grafana (already bundled) | Free | Access Grafana (`http://<url>:3000`) and import the built‑in dashboard (`services/grafana/provisioning/dashboards/dashboard.json`). |

You can selectively spin up these services locally with `docker compose up -d redis redpanda mongo` or use the managed equivalents on the cloud platforms.
---

## 5️⃣ Keeping It Running 24/7
- **Locally**: Use a process manager like `pm2` or simply keep Docker running. On Windows, you can start Docker Desktop on boot.
- **Cloud**: The platforms automatically restart the container on crashes or after deployments. No manual intervention needed.

## 6️⃣ Quick Checklist before pushing to GitHub
1. Commit the new `README.md`, `docker-compose.yml` (with scaling), `nginx/nginx.conf`, and any new env example values.
2. Ensure the CI workflow (`.github/workflows/deploy.yml`) builds the Docker image and pushes to a container registry (Docker Hub or GitHub Packages).
3. Add a **Deploy** button badge in the README for Railway/Render/Fly if you want one‑click deploys.

---

### 🎉 You’re all set!
- **Local testing** – run Docker Compose, open `http://localhost`.
- **Public demo** – start an `ngrok` tunnel or deploy to Railway/Render/Fly and share the generated URL.
- **Showcase** – talk about load‑balancing (NGINX), horizontal scaling (multiple Node.js pods), pub/sub (Redis), stream processing (Redpanda/Kafka), persistence (MongoDB), and observability (Prometheus/Grafana).

Feel free to ask if you need any of the optional services wired into the code or want a CI/CD token walkthrough.
