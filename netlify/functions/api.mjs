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

async function tableExists(name) {
  const rows = await db.sql`
    SELECT to_regclass(${`public.${name}`}) AS reg
  `;
  return Boolean(rows[0]?.reg);
}

async function ensureSchema() {
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS fle_student_places (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      level TEXT NOT NULL,
      place_name TEXT NOT NULL,
      category TEXT,
      recommendation TEXT,
      directions TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      route_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.sql.unsafe(`
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
    )
  `);

  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS fle_b1_contributions_v2 (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      step_id TEXT,
      title TEXT,
      appreciation TEXT NOT NULL,
      audio_key TEXT,
      audio_type TEXT,
      image_key TEXT,
      image_type TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const count = await db.sql`
    SELECT COUNT(*)::int AS count
    FROM fle_papal_steps
  `;

  if ((count[0]?.count ?? 0) === 0) {
    for (const s of seedSteps) {
      await db.sql`
        INSERT INTO fle_papal_steps
        (
          id,
          name,
          address,
          latitude,
          longitude,
          route_order
        )
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

async function readOldB1() {
  if (!(await tableExists("fle_b1_contributions"))) {
    return [];
  }

  const columns = await db.sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fle_b1_contributions'
  `;

  const names = new Set(
    columns.map(row => row.column_name)
  );

  const hasLatitude = names.has("latitude");
  const hasLongitude = names.has("longitude");

  const query = `
    SELECT
      id,
      student_name,
      step_id,
      title,
      appreciation,
      audio_key,
      audio_type,
      image_key,
      image_type,
      ${
        hasLatitude
          ? "latitude"
          : "NULL::double precision AS latitude"
      },
      ${
        hasLongitude
          ? "longitude"
          : "NULL::double precision AS longitude"
      },
      created_at,
      'old'::text AS source
    FROM fle_b1_contributions
    ORDER BY created_at ASC
  `;

  return await db.sql.unsafe(query);
}

async function deleteMedia(row) {
  if (row?.audio_key) {
    try {
      await mediaStore.delete(row.audio_key);
    } catch {}
  }

  if (row?.image_key) {
    try {
      await mediaStore.delete(row.image_key);
    } catch {}
  }
}

export default async (req) => {
  try {
    await ensureSchema();

    const url = new URL(req.url);
    const action =
      url.searchParams.get("action") || "state";

    if (
      action === "state" &&
      req.method === "GET"
    ) {
      const commerces = await db.sql`
        SELECT *
        FROM fle_student_places
        ORDER BY created_at ASC
      `;

      const steps = await db.sql`
        SELECT *
        FROM fle_papal_steps
        WHERE active = TRUE
        ORDER BY route_order ASC, created_at ASC
      `;

      const current = await db.sql`
        SELECT *,
        'v2'::text AS source
        FROM fle_b1_contributions_v2
        ORDER BY created_at ASC
      `;

      const old = await readOldB1();

      const b1 = [
        ...old,
        ...current
      ].sort(
        (a, b) =>
          new Date(a.created_at) -
          new Date(b.created_at)
      );

      return json({
        commerces,
        steps,
        b1
      });
    }

    if (
      action === "commerce" &&
      req.method === "POST"
    ) {
      const body = await req.json();

      const student =
        String(body.student_name || "").trim();

      const level =
        String(body.level || "").trim();

      const place =
        String(body.place_name || "").trim();

      const latitude =
        Number(body.latitude);

      const longitude =
        Number(body.longitude);

      if (
        !student ||
        !["A1", "A2"].includes(level) ||
        !place ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        return json({
          error:
            "Données A1/A2 incomplètes."
        }, 400);
      }

      const id =
        crypto.randomUUID();

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
          longitude
        )
        VALUES (
          ${id},
          ${student},
          ${level},
          ${place},
          ${String(body.category || "")},
          ${String(body.recommendation || "")},
          ${String(body.directions || "")},
          ${latitude},
          ${longitude}
        )
      `;

      return json({
        ok: true,
        id
      }, 201);
    }

    if (
      action === "commerce-delete" &&
      req.method === "DELETE"
    ) {
      const id =
        url.searchParams.get("id");

      if (!id) {
        return json({
          error: "ID manquant."
        }, 400);
      }

      await db.sql`
        DELETE FROM fle_student_places
        WHERE id = ${id}
      `;

      return json({
        ok: true
      });
    }

    if (
      action === "b1" &&
      req.method === "POST"
    ) {
      const form =
        await req.formData();

      const student =
        String(
          form.get("student_name") || ""
        ).trim();

      const stepId =
        String(
          form.get("step_id") || ""
        ).trim();

      const title =
        String(
          form.get("title") || ""
        ).trim();

      const appreciation =
        String(
          form.get("appreciation") || ""
        ).trim();

      const latitude =
        Number(
          form.get("latitude")
        );

      const longitude =
        Number(
          form.get("longitude")
        );

      const audio =
        form.get("audio");

      const image =
        form.get("image");

      if (
        !student ||
        !stepId ||
        !appreciation ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        !(audio instanceof File) ||
        !audio.size
      ) {
        return json({
          error:
            "Témoignage B1 incomplet, point manquant ou audio manquant."
        }, 400);
      }

      if (
        audio.size >
        8 * 1024 * 1024
      ) {
        return json({
          error:
            "Audio trop gros (maximum 8 Mo)."
        }, 413);
      }

      if (
        image instanceof File &&
        image.size >
        4 * 1024 * 1024
      ) {
        return json({
          error:
            "Photo trop grosse après préparation."
        }, 413);
      }

      const id =
        crypto.randomUUID();

      const audioType =
        audio.type ||
        "application/octet-stream";

      const audioKey =
        `b1/${id}/audio`;

      await mediaStore.set(
        audioKey,
        await audio.arrayBuffer(),
        {
          metadata: {
            contentType:
              audioType,
            student,
            kind: "audio"
          }
        }
      );

      let imageKey = null;
      let imageType = null;

      if (
        image instanceof File &&
        image.size
      ) {
        imageType =
          image.type ||
          "application/octet-stream";

        imageKey =
          `b1/${id}/image`;

        await mediaStore.set(
          imageKey,
          await image.arrayBuffer(),
          {
            metadata: {
              contentType:
                imageType,
              student,
              kind: "image"
            }
          }
        );
      }

      await db.sql`
        INSERT INTO fle_b1_contributions_v2
        (
          id,
          student_name,
          step_id,
          title,
          appreciation,
          audio_key,
          audio_type,
          image_key,
          image_type,
          latitude,
          longitude
        )
        VALUES (
          ${id},
          ${student},
          ${stepId},
          ${title},
          ${appreciation},
          ${audioKey},
          ${audioType},
          ${imageKey},
          ${imageType},
          ${latitude},
          ${longitude}
        )
      `;

      return json({
        ok: true,
        id
      }, 201);
    }

    if (
      action === "b1-delete" &&
      req.method === "DELETE"
    ) {
      const id =
        url.searchParams.get("id");

      const source =
        url.searchParams.get("source") ||
        "v2";

      if (!id) {
        return json({
          error: "ID manquant."
        }, 400);
      }

      if (
        source === "old" &&
        await tableExists(
          "fle_b1_contributions"
        )
      ) {
        const rows = await db.sql`
          SELECT
            audio_key,
            image_key
          FROM fle_b1_contributions
          WHERE id = ${id}
        `;

        await deleteMedia(
          rows[0]
        );

        await db.sql`
          DELETE FROM fle_b1_contributions
          WHERE id = ${id}
        `;
      } else {
        const rows = await db.sql`
          SELECT
            audio_key,
            image_key
          FROM fle_b1_contributions_v2
          WHERE id = ${id}
        `;

        await deleteMedia(
          rows[0]
        );

        await db.sql`
          DELETE FROM fle_b1_contributions_v2
          WHERE id = ${id}
        `;
      }

      return json({
        ok: true
      });
    }

    if (
      action === "media" &&
      req.method === "GET"
    ) {
      const key =
        url.searchParams.get("key");

      if (
        !key ||
        !key.startsWith("b1/")
      ) {
        return new Response(
          "Invalid key",
          {
            status: 400
          }
        );
      }

      const entry =
        await mediaStore
          .getWithMetadata(
            key,
            {
              type: "arrayBuffer",
              consistency: "strong"
            }
          );

      if (
        !entry ||
        entry.data === null
      ) {
        return new Response(
          "Not found",
          {
            status: 404
          }
        );
      }

      return new Response(
        entry.data,
        {
          status: 200,
          headers: {
            "Content-Type":
              entry.metadata?.contentType ||
              "application/octet-stream",

            "Cache-Control":
              "private, max-age=3600"
          }
        }
      );
    }

    return json({
      error:
        "Action inconnue."
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
