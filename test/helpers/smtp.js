import net from "node:net";
import nodemailer from "nodemailer";

// Scripted plain-text SMTP server on 127.0.0.1. `mode` decides how it misbehaves:
//   ok            accepts everything, replies 250 after DATA
//   die-after-data  354 on DATA, reads the body, then destroys the socket without replying
//   reply-then-die  replies "250 OK queued" after the body and immediately destroys the socket
//   reject-rcpt   550 on RCPT TO
//   reject-auth   advertises AUTH and answers 535 to it (a wrong app password)
// `dataConnections` counts connections that reached the DATA command (message may be delivered).
export async function startFakeSmtp(mode = "ok") {
  const state = { mode, dataConnections: 0, bodies: [] };
  const server = net.createServer((socket) => {
    let buf = "";
    let inData = false;
    let body = "";
    socket.on("error", () => {});
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          body += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          state.bodies.push(body);
          if (state.mode === "die-after-data") return void socket.destroy();
          if (state.mode === "reply-then-die") {
            socket.write("250 OK queued\r\n", () => socket.destroy());
            return;
          }
          socket.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) socket.write(state.mode === "reject-auth" ? "250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n" : "250-fake\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH")) socket.write("535 5.7.8 Username and Password not accepted\r\n");
        else if (cmd.startsWith("MAIL FROM")) socket.write("250 OK\r\n");
        else if (cmd.startsWith("RCPT TO")) socket.write(state.mode === "reject-rcpt" ? "550 5.1.1 no such user\r\n" : "250 OK\r\n");
        else if (cmd === "DATA") {
          state.dataConnections++;
          inData = true;
          body = "";
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    state,
    port,
    setMode: (m) => (state.mode = m),
    transport: (extra = {}) =>
      nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, ...extra }),
    close: () => new Promise((r) => (server.close(r), server.closeAllConnections?.())),
  };
}

// A port that nothing listens on.
export async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// Run a real nodemailer send against a scripted server and return the error it produces.
export async function realError(transport) {
  try {
    await transport.sendMail({ from: "a@example.com", to: "b@example.com", subject: "s", text: "t" });
  } catch (err) {
    return err;
  }
  return null;
}
