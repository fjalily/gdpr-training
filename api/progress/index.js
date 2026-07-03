// Sporing av GDPR-opplæring: både modul-fullføring og seksjon-nivå fremdrift.
// Mønster kopiert fra Compliance-treningens api/progress, utvidet med
// seksjonssporing (type: "section") slik at vi ser nøyaktig hvor langt
// hver ansatt har kommet i hver modul, ikke bare om modulen er fullført.

const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");

const account = process.env.STORAGE_ACCOUNT;
const accountKey = process.env.STORAGE_KEY;
const tableName = "GdprTrainingProgress";

function getClient() {
  if (!account || !accountKey) {
    throw new Error("STORAGE_ACCOUNT or STORAGE_KEY is not configured.");
  }
  const credential = new AzureNamedKeyCredential(account, accountKey);
  return new TableClient(
    `https://${account}.table.core.windows.net`,
    tableName,
    credential
  );
}

function getPrincipal(req) {
  const principalHeader = req.headers["x-ms-client-principal"];
  if (!principalHeader) return null;
  try {
    const decoded = Buffer.from(principalHeader, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (e) {
    return null;
  }
}

function maskIp(ip) {
  if (!ip) return null;
  const first = ip.split(",")[0].trim();
  return first.replace(/\.\d+$/, ".0");
}

// RowKey-konvensjoner:
//   modul-fullføring:  "<moduleId>"                     type = "module"
//   seksjon-fremdrift: "<moduleId>_section_<sectionIdx>" type = "section"
function moduleRowKey(moduleId) {
  return String(moduleId);
}
function sectionRowKey(moduleId, sectionIdx) {
  return String(moduleId) + "_section_" + String(sectionIdx);
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const user = principal ? principal.userDetails : null;

    // ---- Admin mode: GET /api/progress?mode=admin ----
    if (req.method === "GET" && req.query && req.query.mode === "admin") {
      if (!principal) {
        context.res = { status: 401, body: { error: "Not authenticated" } };
        return;
      }
      const roles = principal.userRoles || [];
      if (!roles.includes("gdpradmin")) {
        context.res = {
          status: 403,
          body: {
            error: "Forbidden — gdpradmin role required",
            you: principal.userDetails,
            roles
          }
        };
        return;
      }

      const client = getClient();
      const entities = [];
      for await (const e of client.listEntities()) {
        entities.push(e);
      }

      const usersMap = {};
      for (const e of entities) {
        const u = e.user || e.partitionKey;
        if (!usersMap[u]) {
          usersMap[u] = {
            user: u,
            authenticated: e.authenticated === true,
            modules: {},   // moduleId -> { score, total, completedAt }
            sections: {}   // moduleId -> { sectionIdx: completedAt }
          };
        }
        if (e.authenticated === true) usersMap[u].authenticated = true;

        if (e.type === "section") {
          if (!usersMap[u].sections[e.moduleId]) usersMap[u].sections[e.moduleId] = {};
          usersMap[u].sections[e.moduleId][e.sectionIdx] = e.completedAt;
        } else {
          // default / "module"
          usersMap[u].modules[e.moduleId] = {
            score: e.score,
            total: e.total,
            completedAt: e.completedAt
          };
        }
      }

      const users = Object.values(usersMap).sort(function (a, b) {
        return a.user.localeCompare(b.user);
      });

      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: {
          admin: principal.userDetails,
          generatedAt: new Date().toISOString(),
          totalUsers: users.length,
          users
        }
      };
      return;
    }

    // ---- GET — egen fremdrift / health check ----
    if (req.method === "GET") {
      if (!user) {
        context.res = {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            status: "ok",
            message: "API is alive. No authenticated user — auth not configured yet.",
            storageConfigured: Boolean(account && accountKey)
          }
        };
        return;
      }

      const client = getClient();
      const modules = {};
      const sections = {};
      for await (const entity of client.listEntities({
        queryOptions: { filter: `PartitionKey eq '${user}'` }
      })) {
        if (entity.type === "section") {
          if (!sections[entity.moduleId]) sections[entity.moduleId] = {};
          sections[entity.moduleId][entity.sectionIdx] = entity.completedAt;
        } else {
          modules[entity.moduleId] = {
            score: entity.score,
            total: entity.total,
            completedAt: entity.completedAt
          };
        }
      }
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { user, modules, sections }
      };
      return;
    }

    // ---- POST — registrer fremdrift ----
    if (req.method === "POST") {
      const body = req.body || {};
      const { moduleId, sectionIdx, score, total, completedAt, kind } = body;

      if (!moduleId) {
        context.res = { status: 400, body: { error: "Missing moduleId" } };
        return;
      }

      const effectiveUser = user || "anonymous-test-user";
      const client = getClient();
      const now = completedAt || new Date().toISOString();

      // Seksjon-nivå event (kind: "section") — én rad per seksjon per bruker
      if (kind === "section") {
        if (sectionIdx === undefined || sectionIdx === null) {
          context.res = { status: 400, body: { error: "Missing sectionIdx for kind=section" } };
          return;
        }
        const entity = {
          partitionKey: effectiveUser,
          rowKey: sectionRowKey(moduleId, sectionIdx),
          user: effectiveUser,
          moduleId: String(moduleId),
          sectionIdx: Number(sectionIdx),
          type: "section",
          completedAt: now,
          ipMasked: maskIp(req.headers["x-forwarded-for"]),
          authenticated: Boolean(user)
        };
        await client.upsertEntity(entity, "Replace");
        context.res = {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { ok: true, user: effectiveUser, moduleId: String(moduleId), sectionIdx: Number(sectionIdx) }
        };
        return;
      }

      // Modul-fullføring (default) — én rad per modul per bruker
      const entity = {
        partitionKey: effectiveUser,
        rowKey: moduleRowKey(moduleId),
        user: effectiveUser,
        moduleId: String(moduleId),
        type: "module",
        score: Number(score) || 0,
        total: Number(total) || 0,
        completedAt: now,
        ipMasked: maskIp(req.headers["x-forwarded-for"]),
        authenticated: Boolean(user)
      };
      await client.upsertEntity(entity, "Replace");
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { ok: true, user: effectiveUser, moduleId: String(moduleId) }
      };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error("Progress API error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "Internal error" }
    };
  }
};
