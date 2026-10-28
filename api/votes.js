// Guarda y devuelve los votos (hasta 3 casas por persona).
// Login: Clerk (con Google). Base de datos: Upstash Redis.
const { verifyToken, createClerkClient } = require("@clerk/backend");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.CLERK_SECRET_KEY;
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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Falta conectar la base de datos (Storage > Upstash Redis)." });
  try {
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", KEY])) || [];
      const votes = {};
      for (let i = 0; i < flat.length; i += 2) {
        try {
          const v = JSON.parse(flat[i + 1]);
          const picks = (v.picks || []).filter((p) => OPTIONS.has(p)).slice(0, MAXV);
          if (picks.length) votes[flat[i]] = { name: v.name, image: v.image, picks };
        } catch {}
      }
      return res.status(200).json({ votes });
    }

    if (req.method === "POST") {
      if (!SECRET) return res.status(500).json({ error: "Falta conectar Clerk." });
      const auth = req.headers.authorization || "";
      const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let userId;
      try {
        const payload = await verifyToken(jwt, { secretKey: SECRET });
        userId = payload.sub;
      } catch {
        return res.status(401).json({ error: "Iniciá sesión para votar." });
      }

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const picks = [...new Set(Array.isArray(body.picks) ? body.picks : [])];
      if (picks.length > MAXV || !picks.every((p) => OPTIONS.has(p))) {
        return res.status(400).json({ error: "Podés votar hasta 3 casas de la lista." });
      }

      const clerk = createClerkClient({ secretKey: SECRET });
      const u = await clerk.users.getUser(userId);
      const email = (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || "";
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email.split("@")[0] || "Alguien";
      const image = u.imageUrl || "";

      if (picks.length) await redis(["HSET", KEY, userId, JSON.stringify({ name, image, picks })]);
      else await redis(["HDEL", KEY, userId]);
      return res.status(200).json({ ok: true, name, image, picks });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "Error del servidor." });
  }
};
