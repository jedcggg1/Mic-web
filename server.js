// Proximity Mic backend
// - รับการเชื่อมต่อจาก Minecraft (/connect <ip>:3000) แล้วดึงตำแหน่ง + สถานะไมค์ของผู้เล่น
// - เปิดเว็บให้ผู้เล่นเข้า และช่วยส่งสัญญาณ WebRTC ระหว่างเว็บของแต่ละคน

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID, randomInt } = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const RANGES = [8, 16, 24, 32, 40, 48, 56, 64]; // ต้องตรงกับ addon
const POS_INTERVAL = 500;     // ms ดึงตำแหน่ง
const ROSTER_INTERVAL = 2000; // ms ดึงชื่อ/สถานะไมค์
const NOPOLL = !!process.env.NOPOLL; // NOPOLL=1 npm start = ต่ออย่างเดียว ไม่ส่งคำสั่งใดๆ (ไว้ทดสอบ)
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// ---------- HTTP (เสิร์ฟหน้าเว็บ) ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const mcWss = new WebSocketServer({ noServer: true });
const webWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const wss = req.url.startsWith("/web") ? webWss : mcWss;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---------- สถานะเกม ----------
let players = {}; // ชื่อ -> { x,y,z,yaw,dim,on,range }
let mcOnline = false;
const codes = new Map();    // รหัสเชื่อม -> { name, exp }
const sessions = new Map(); // token (ต่อใหม่อัตโนมัติ) -> ชื่อผู้เล่น

// ---------- Minecraft ----------
mcWss.on("connection", (mc) => {
  console.log("[MC] connected");
  mcOnline = true;
  const pending = new Map();

  const send = (cmd, cb) => {
    const id = randomUUID();
    pending.set(id, cb);
    mc.send(JSON.stringify({
      header: { version: 1, requestId: id, messageType: "commandRequest", messagePurpose: "commandRequest" },
      body: { origin: { type: "player" }, commandLine: cmd, version: 1 },
    }));
    setTimeout(() => pending.delete(id), 5000);
  };
  const ask = (cmd) => new Promise((resolve) => send(cmd, resolve));
  const victims = async (cmd) => {
    const b = await ask(cmd);
    return b.statusCode === 0 && Array.isArray(b.victim) ? b.victim : [];
  };

  // ผู้เล่นพิมพ์ !link ในแชต -> สร้างรหัส 6 หลัก แล้วส่งกลับให้เฉพาะคนนั้น
  function giveCode(name) {
    if (!name) return;
    for (const [c, v] of codes) if (v.name === name || v.exp < Date.now()) codes.delete(c);
    const code = String(randomInt(100000, 1000000));
    codes.set(code, { name, exp: Date.now() + 5 * 60 * 1000 });
    const safe = name.replace(/"/g, "");
    const text = `§aรหัสเชื่อมเว็บ: §e${code} §7(ใช้ได้ 5 นาที)`;
    send(`tellraw @a[name="${safe}"] ${JSON.stringify({ rawtext: [{ text }] })}`, () => {});
    console.log(`[link] ${name} -> ${code}`);
  }

  // สมัครรับเหตุการณ์แชต
  if (!NOPOLL) mc.send(JSON.stringify({
    header: { version: 1, requestId: randomUUID(), messageType: "commandRequest", messagePurpose: "subscribe" },
    body: { eventName: "PlayerMessage" },
  }));

  mc.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const h = m.header || {};
    if (process.env.DEBUG) console.log("[MC<-]", String(raw).slice(0, 300));
    if (h.eventName === "PlayerMessage") {
      const b = m.body || {};
      if (b.type === "chat" && String(b.message).trim().toLowerCase() === "!link") giveCode(b.sender);
      return;
    }
    const cb = pending.get(h.requestId);
    if (cb) { pending.delete(h.requestId); cb(m.body || {}); }
  });

  async function pollRoster() {
    const all = await victims("testfor @a");
    const onList = await victims("testfor @a[tag=mic_on]");
    const onSet = new Set(onList);
    const rangeOf = {};
    if (onSet.size > 0) {
      for (const r of RANGES) for (const n of await victims(`testfor @a[tag=micr_${r}]`)) rangeOf[n] = r;
    }
    const next = {};
    for (const name of all) {
      next[name] = { ...(players[name] || { x: 0, y: 0, z: 0, yaw: 0, dim: 0 }), on: onSet.has(name), range: rangeOf[name] || 16 };
    }
    players = next;
  }

  async function pollPositions() {
    for (const name of Object.keys(players)) {
      const safe = name.replace(/"/g, "");
      const b = await ask(`querytarget @a[name="${safe}"]`);
      if (b.statusCode !== 0 || !b.details) continue;
      try {
        const d = JSON.parse(b.details)[0];
        if (d && players[name]) {
          Object.assign(players[name], { x: d.position.x, y: d.position.y, z: d.position.z, yaw: d.yRot || 0, dim: d.dimension || 0 });
        }
      } catch {}
    }
  }

  let busy1 = false, busy2 = false;
  const t1 = NOPOLL ? null : setInterval(async () => {
    if (busy1) return; busy1 = true;
    try { await pollRoster(); } catch (e) { console.log("[roster]", e.message); }
    busy1 = false;
  }, ROSTER_INTERVAL);
  const t2 = NOPOLL ? null : setInterval(async () => {
    if (busy2) return; busy2 = true;
    try { await pollPositions(); } catch (e) { console.log("[pos]", e.message); }
    busy2 = false;
  }, POS_INTERVAL);
  if (NOPOLL) console.log("[MC] NOPOLL: ไม่ส่งคำสั่งใดๆ ไปที่เกม");

  mc.on("error", (e) => console.log("[MC] error", e.message));
  mc.on("close", (code) => {
    console.log("[MC] disconnected code=" + code);
    if (t1) clearInterval(t1); if (t2) clearInterval(t2);
    mcOnline = false; players = {};
  });
});

// ---------- เว็บ (signaling + ส่งสถานะ) ----------
const clients = new Map(); // ws -> { id, name }
const sendTo = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

webWss.on("connection", (ws) => {
  const me = { id: randomUUID().slice(0, 8), name: null };
  clients.set(ws, me);

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "join") {
      let name = null, token = null;
      if (m.resume && sessions.has(m.resume)) { token = m.resume; name = sessions.get(token); }
      else {
        const key = String(m.code || "").trim();
        const c = codes.get(key);
        if (c && c.exp > Date.now()) { name = c.name; codes.delete(key); token = randomUUID(); sessions.set(token, name); }
      }
      if (!name) return sendTo(ws, { type: "join-error", reason: "รหัสไม่ถูกต้องหรือหมดอายุ พิมพ์ !link ในแชตเกมเพื่อรับรหัสใหม่" });
      // ถ้าชื่อนี้ต่ออยู่แล้ว (เช่น แท็บเก่า) ให้ตัดแท็บเก่าออก
      for (const [other, c] of clients) if (c !== me && c.name === name) other.close();
      me.name = name;
      const peers = [...clients.values()].filter((c) => c !== me && c.name && c.name !== name).map((c) => ({ id: c.id, name: c.name }));
      sendTo(ws, { type: "welcome", id: me.id, name, token, peers });
      for (const [other, c] of clients) if (other !== ws && c.name && c.name !== name) sendTo(other, { type: "peer-joined", id: me.id, name });
    }

    if (m.type === "signal") {
      for (const [other, c] of clients) if (c.id === m.to) sendTo(other, { type: "signal", from: me.id, data: m.data });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    for (const other of clients.keys()) sendTo(other, { type: "peer-left", id: me.id });
  });
});

setInterval(() => {
  const msg = JSON.stringify({ type: "state", mcOnline, players });
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(msg);
}, 200);

server.listen(PORT, () => {
  console.log(`เปิดเว็บที่ http://localhost:${PORT}`);
  console.log(`ในเกมพิมพ์: /connect localhost:${PORT}`);
});
