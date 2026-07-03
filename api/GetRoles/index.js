// Custom roles-funksjon for Azure Static Web Apps.
//
// SWA sin innebygde Entra ID-autentisering plukker IKKE automatisk opp
// App roles fra Entra-tokenet inn i userRoles — det krever en egen
// "rolesSource"-funksjon (se staticwebapp.config.json: auth.rolesSource).
// SWA kaller dette endepunktet ved innlogging med brukerens claims i body,
// og forventer { "roles": [...] } tilbake. De rollene legges så til
// i clientPrincipal.userRoles og kan brukes i routes/allowedRoles.
//
// Entra ID sender App roles som en "roles"-claim i ID-tokenet (bekreftet
// via /.auth/me -> claims -> { "typ": "roles", "val": "gdpradmin" }).
// Denne funksjonen plukker den claimen opp og mapper den videre.

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const claims = body.claims || [];

    const roles = claims
      .filter(function (c) { return c.typ === "roles" || c.typ === "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"; })
      .map(function (c) { return c.val; });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { roles: roles }
    };
  } catch (err) {
    context.log.error("GetRoles error:", err);
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { roles: [] }
    };
  }
};
