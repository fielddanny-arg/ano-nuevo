// Guarda y devuelve los votos (hasta 3 casas por persona).
// Login: Clerk (con Google). Base de datos: Upstash Redis.
// Cada persona solo recibe sus propios votos y cuántos votaron en total.
// Los emails de ADMIN_EMAILS (variable de entorno en Vercel) reciben todos los votos.
const { verifyToken, createClerkClient } = require("@clerk/backend");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.CLERK_SECRET_KEY;
const ADMINS = (process.env.ADMIN_EMAILS || "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const KEY = "votos-ano-nuevo-v2";
const MAXV = 3;
const OPTIONS = new Set(require("./options.json"));

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}

// Devuelve el usuario de Clerk si el token es válido, o null.
async function currentUser(req) {
  if (!SECRET) return null;
  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt) return null;
  try {
    const payload = await verifyToken(jwt, { secretKey: SECRET });
    const clerk = createClerkClient({ secretKey: SECRET });
    const u = await clerk.users.getUser(payload.sub);
    const emails = (u.emailAddresses || [])
      .filter((e) => !e.verification || e.verification.status === "verified")
      .map((e) => e.emailAddress.toLowerCase());
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || (emails[0] || "").split("@")[0] || "Alguien";
    return { id: u.id, name, image: u.imageUrl || "", isAdmin: emails.some((e) => ADMINS.includes(e)) };
  } catch {
    return null;
  }
}

async function readAll() {
  const flat = (await redis(["HGETALL", KEY])) || [];
  const votes = {};
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const v = JSON.parse(flat[i + 1]);
      const picks = (v.picks || []).filter((p) => OPTIONS.has(p)).slice(0, MAXV);
      if (picks.length) votes[flat[i]] = { name: v.name, image: v.image, picks };
    } catch {}
  }
  return votes;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Falta conectar la base de datos (Storage > Upstash Redis)." });
  try {
    if (req.method === "GET") {
      const [all, user] = await Promise.all([readAll(), currentUser(req)]);
      const voters = Object.keys(all).length;
      if (user && user.isAdmin) return res.status(200).json({ isAdmin: true, voters, votes: all });
      const votes = user && all[user.id] ? { [user.id]: all[user.id] } : {};
      return res.status(200).json({ isAdmin: false, voters, votes });
    }

    if (req.method === "POST") {
      if (!SECRET) return res.status(500).json({ error: "Falta conectar Clerk." });
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: "Iniciá sesión para votar." });

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const picks = [...new Set(Array.isArray(body.picks) ? body.picks : [])];
      if (picks.length > MAXV || !picks.every((p) => OPTIONS.has(p))) {
        return res.status(400).json({ error: "Podés votar hasta 3 casas de la lista." });
      }

      if (picks.length) await redis(["HSET", KEY, user.id, JSON.stringify({ name: user.name, image: user.image, picks })]);
      else await redis(["HDEL", KEY, user.id]);
      return res.status(200).json({ ok: true, name: user.name, image: user.image, picks });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "Error del servidor." });
  }
};
