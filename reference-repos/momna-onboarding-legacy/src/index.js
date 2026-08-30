export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "momna-backend"
      });
    }

    return Response.json({
      name: "Momna Backend",
      status: "running"
    });
  }
};
