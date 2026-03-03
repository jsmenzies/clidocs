export function redirectHome(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "https://github.com/jsmenzies/clidocs",
    },
  });
}
