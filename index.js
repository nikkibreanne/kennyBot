require("dotenv").config();
const tmi = require("tmi.js");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

// LocalStorage is a lowdb adapter for saving to localStorage
const adapter = new FileSync("db.json");
// Create database instance
const db = low(adapter);

// set default options
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

// initialize database and functions
// Set default state
db.defaults({ items: [] }).write();

function add() {
  db.get("items")
    .push({ time: Date.now() })
    .write();
}

function reset() {
  db.set("items", []).write();
}

function read() {
  const state = db.getState();
  return (str = JSON.stringify(state, null, 2));
}

// initialize chat client
const client = new tmi.client(options);

// connect client
client.connect();

// define client functionality
client.on("connected", (address, port) => {
  client.action("scasplte2", "Hello, kennyBot is now connected");
});

client.on("chat", (channel, user, message, self) => {
  console.log(user);
  if (message === "!test") {
    client.action("scasplte2", "Testing whether a command can work!");
  }

  if (user["display-name"] === "scasplte2") {
    client.action(
      "scasplte2",
      `Hello scasplte2! I hear you are talking about me?`
    );
  }

  if (message === "!add") {
    add();
  }

  if (message === "!reset") {
    reset();
  }

  // TODO: adding ACTION before the message in IRC chat for some reason
  if (message === "!read") {
    console.log(read());
    client.action("scasplte2", `The new db state is: ${read()}`);
  }

  client.action("scasplte2", `Hello ${user["display-name"]}!`);
});
