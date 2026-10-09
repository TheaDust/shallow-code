import { createServer } from "node:http";

let profileName = "";

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Profile fixture</title></head>
  <body>
    <main>
      <label for="profile-name">Profile name</label>
      <input id="profile-name" name="profile-name">
      <button type="button" id="save">Save</button>
      <button type="button" id="rename" aria-label="Rename">Rename</button>
      <button type="button" id="hint" aria-label="Hint">Hint</button>
      <p role="status" id="status"></p>
    </main>
    <script type="module">
      const input = document.querySelector('#profile-name');
      const status = document.querySelector('#status');
      const current = await fetch('/api/profile').then((response) => response.json());
      input.value = current.name;
      const save = async () => {
        const saved = await fetch('/api/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: input.value }),
        }).then((response) => response.json());
        input.value = saved.name;
        status.textContent = 'Saved';
      };
      document.querySelector('#save').addEventListener('click', save);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void save();
      });
      document.querySelector('#rename').addEventListener('dblclick', () => {
        status.textContent = 'Renamed';
      });
      document.querySelector('#hint').addEventListener('mouseenter', () => {
        status.textContent = 'Hovered';
      });
    </script>
  </body>
</html>`;

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.url === "/api/profile" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: profileName }));
    return;
  }
  if (request.url === "/api/profile" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    profileName = String(body.name ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: profileName }));
    return;
  }
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`fixture app listening on ${port}`);
});
