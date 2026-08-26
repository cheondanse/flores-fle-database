import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";

const db = getDatabase();
const mediaStore = getStore("flores-fle-media");

const seedSteps = [
  ["bas","Basílica San José de Flores","Av. Rivadavia 6950, Flores, Buenos Aires",-34.6297,-58.4631,1],
  ["solar","Solar de la Infancia","Membrillar 531, Flores, Buenos Aires",null,null,2],
  ["miser","Instituto Nuestra Señora de la Misericordia","Av. Directorio 2138, Flores, Buenos Aires",null,null,3],
  ["plaz","Plazoleta Herminia Brumana","Membrillar y Francisco Bilbao, Flores, Buenos Aires",null,null,4],
  ["esc","Escuela Nº 8 D.E. 11 « Cnel. Ing. Pedro Antonio Cerviño »","Varela 358, Flores, Buenos Aires",null,null,5],
  ["vic","Vicaría de San José de Flores","Condarco 545, Flores, Buenos Aires",null,null,6],
  ["enet","E.N.E.T. Nº 27 « Hipólito Yrigoyen »","Virgilio 1980, Monte Castro, Buenos Aires",null,null,7],
  ["carcel","Servicio Penitenciario – Cárcel de Devoto","Bahía Blanca 363, Villa Devoto, Buenos Aires",null,null,8],
  ["semi","Seminario Metropolitano de Buenos Aires","José Cubas 3543, Villa Devoto, Buenos Aires",null,null,9],
  ["talar","Parroquia San José del Talar – Virgen Desatanudos","Navarro 2460, Agronomía, Buenos Aires",null,null,10]
];

async function ensureSchema() {
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS fle_student_places (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('A1','A2')),
      place_name TEXT NOT NULL,
      category TEXT,
      recommendation TEXT,
      directions TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      route_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fle_papal_steps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      description TEXT,
      route_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fle_b1_contributions (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      step_id TEXT REFERENCES fle_papal_steps(id) ON DELETE SET NULL,
      title TEXT,
      appreciation TEXT NOT NULL,
      audio_key TEXT,
      audio_type TEXT,
      image_key TEXT,
      image_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const existing = await db.sql`
    SELECT COUNT(*)::int AS count
    FROM fle_papal_steps
  `;

  if ((existing[0]?.count ?? 0) === 0) {
    for (const s of seedSteps) {
      await db.sql`
        INSERT INTO fle_papal_steps
        (id, name, address, latitude, longitude, route_order)
        VALUES (
          ${s[0]},
          ${s[1]},
          ${s[2]},
          ${s[3]},
          ${s[4]},
          ${s[5]}
        )
      `;
    }
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function uuid() {
  return crypto.randomUUID();
}

export default async (req) => {
  try {
    await ensureSchema();

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";

    if (action === "state" && req.method === "GET") {
      const commerces = await db.sql`
        SELECT *
        FROM fle_student_places
        ORDER BY route_order ASC, created_at ASC
      `;

      const steps = await db.sql`
        SELECT *
        FROM fle_papal_steps
        WHERE active = TRUE
        ORDER BY route_order ASC, created_at ASC
      `;

      const b1 = await db.sql`
        SELECT *
        FROM fle_b1_contributions
        ORDER BY created_at ASC
      `;

      return json({
        commerces,
        steps,
        b1
      });
    }

    if (action === "commerce" && req.method === "POST") {
      const body = await req.json();

      const student = String(body.student_name || "").trim();
      const level = String(body.level || "").trim();
      const place = String(body.place_name || "").trim();
      const lat = Number(body.latitude);
      const lng = Number(body.longitude);

      if (
        !student ||
        !["A1", "A2"].includes(level) ||
        !place ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        return json({
          error: "Données A1/A2 incomplètes."
        }, 400);
      }

      const count = await db.sql`
        SELECT COUNT(*)::int AS count
        FROM fle_student_places
      `;

      const id = uuid();

      await db.sql`
        INSERT INTO fle_student_places
        (
          id,
          student_name,
          level,
          place_name,
          category,
          recommendation,
          directions,
          latitude,
          longitude,
          route_order
        )
        VALUES (
          ${id},
          ${student},
          ${level},
          ${place},
          ${String(body.category || "")},
          ${String(body.recommendation || "")},
          ${String(body.directions || "")},
          ${lat},
          ${lng},
          ${(count[0]?.count ?? 0) + 1}
        )
      `;

      return json({
        ok: true,
        id
      }, 201);
    }

    if (action === "b1" && req.method === "POST") {
      const form = await req.formData();

      const student = String(form.get("student_name") || "").trim();
      const stepId = String(form.get("step_id") || "").trim();
      const title = String(form.get("title") || "").trim();
      const appreciation = String(form.get("appreciation") || "").trim();

      const audio = form.get("audio");
      const image = form.get("image");

      if (
        !student ||
        !stepId ||
        !appreciation ||
        !(audio instanceof File) ||
        audio.size === 0
      ) {
        return json({
          error: "Témoignage B1 incomplet ou audio manquant."
        }, 400);
      }

      const id = uuid();

      const safeAudioType =
        audio.type || "application/octet-stream";

      const audioKey = `b1/${id}/audio`;

      await mediaStore.set(
        audioKey,
        await audio.arrayBuffer(),
        {
          metadata: {
            contentType: safeAudioType,
            student,
            kind: "audio"
          }
        }
      );

      let imageKey = null;
      let imageType = null;

      if (image instanceof File && image.size > 0) {
        imageType =
          image.type || "application/octet-stream";

        imageKey = `b1/${id}/image`;

        await mediaStore.set(
          imageKey,
          await image.arrayBuffer(),
          {
            metadata: {
              contentType: imageType,
              student,
              kind: "image"
            }
          }
        );
      }

      await db.sql`
        INSERT INTO fle_b1_contributions
        (
          id,
          student_name,
          step_id,
          title,
          appreciation,
          audio_key,
          audio_type,
          image_key,
          image_type
        )
        VALUES (
          ${id},
          ${student},
          ${stepId},
          ${title},
          ${appreciation},
          ${audioKey},
          ${safeAudioType},
          ${imageKey},
          ${imageType}
        )
      `;

      return json({
        ok: true,
        id
      }, 201);
    }

    if (action === "media" && req.method === "GET") {
      const key = url.searchParams.get("key");

      if (!key || !key.startsWith("b1/")) {
        return new Response("Invalid key", {
          status: 400
        });
      }

      const entry = await mediaStore.getWithMetadata(
        key,
        {
          type: "arrayBuffer",
          consistency: "strong"
        }
      );

      if (!entry || entry.data === null) {
        return new Response("Not found", {
          status: 404
        });
      }

      const contentType =
        entry.metadata?.contentType ||
        "application/octet-stream";

      return new Response(
        entry.data,
        {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "private, max-age=3600",
            "Content-Length": String(
              entry.data.byteLength
            )
          }
        }
      );
    }

    if (action === "step" && req.method === "PATCH") {
      const body = await req.json();

      const id = String(body.id || "");

      if (!id) {
        return json({
          error: "Étape manquante."
        }, 400);
      }

      await db.sql`
        UPDATE fle_papal_steps
        SET
          name = ${String(body.name || "")},
          address = ${String(body.address || "")},
          latitude = ${
            body.latitude === null ||
            body.latitude === ""
              ? null
              : Number(body.latitude)
          },
          longitude = ${
            body.longitude === null ||
            body.longitude === ""
              ? null
              : Number(body.longitude)
          },
          route_order = ${
            Number.isFinite(Number(body.route_order))
              ? Number(body.route_order)
              : 0
          }
        WHERE id = ${id}
      `;

      return json({
        ok: true
      });
    }

    return json({
      error: "Action inconnue."
    }, 404);

  } catch (error) {
    console.error(
      "API Flores FLE:",
      error
    );

    return json({
      error:
        error?.message ||
        "Erreur serveur."
    }, 500);
  }
};
