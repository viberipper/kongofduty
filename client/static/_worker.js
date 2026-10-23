const verificationPath = "/google1d173127dede3ccd.html";
const verificationBody = "google-site-verification: google1d173127dede3ccd.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === verificationPath) {
      return new Response(request.method === "HEAD" ? null : verificationBody, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
