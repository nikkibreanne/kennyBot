require("dotenv").config();
const tmi = require("tmi.js");

const options = {
  options: {
    debug: true
  },
  connection: {
    cluster: "aws",
    reconnect: true,
    secure: true
  },
  identity: {
    username: "theKennyBot",
    password: process.env.oauthToken
  },
  channels: ["scasplte2"]
};

const client = new tmi.client(options);

client.connect();

client.on("connected", (address, port) => {
  client.action("scasplte2", "Hello, kennyBot is now connected");
});

client.on("chat", (channel, user, message, self) => {
  if (message === "!test") {
    client.action("scasplte2", "Testing whether a command can work!");
  }

  client.action("scasplte2", `Hello ${user["display-name"]}!`);
});
