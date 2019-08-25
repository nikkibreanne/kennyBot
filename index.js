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

// Set default database state
db.defaults({ pokemon: [], user: {}, catchablePokemon: "" }).write();

// Define functions
function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

function readPoke(pokeID) {
  const poke = db
    .get("pokemon")
    .find({ id: pokeID })
    .value();
  return poke.name;
  //   return (str = JSON.stringify(poke.name, null, 2));
}

function getUser(username) {
    return db
      .get("user")
      .find({ name: username })
      .value();
  }
  
  function isUserInDB(username) {
    let existingUser = false;
    if (getUser(username)) {
      existingUser = true;
    }
    return existingUser;
  }
  
  function newUser(username) {
    db.get("user")
      .push({{ name: username, pokemon: [] }})
      .write();
  }
  
function updateUser() {}

function updateCatchablePokemon(wildPokemon) {
  db.set("catchablePokemon", wildPokemon).write();
}

// function to check if the user is registered and to attempt catch if so
function allowAttempt(username) {
  let msg = "";
  if (isUserInDB(username)) {
    msg = attemptCatch(username);
  } else {
    msg = `Sorry ${username}, please visit Professor Oak ( !visitprofoak ) to register your Pokedex before trying to catch Pokemon.`;
  }
  return msg;
}

// function to compute the catch attempt
function attemptCatch(username) {
  // Retrieve catchable pokemon for convenience
  const wildPK = db.get("catchablePokemon").value();
  // calculate normalization (makes catching more variable)
  //const normalization = getRandomInt(12);
  const normalization = 1;
  // calculate attempt
  const attempt = getRandomInt(100);
  // check if the pokemon was caught
  let msg = "";
  if (wildPK) {
    if (attempt < 100 / normalization) {
      msg = `Congratulations ${username}! You caught a ${wildPK}.`;
      updateUser(username);
      const poke = db
        .get("pokemon")
        .find({ name: wildPK })
        .value();
      console.log(poke);
    } else {
      updateCatchablePokemon("");
      msg = `Your pokeball missed ${username}! You scared away the ${wildPK}.`;
    }
  } else {
    msg = `Sorry ${username}. There are currently no wild pokemon around to catch.`;
  }
  return msg;
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
  switch (message) {
    case "!pokeball":
      client.action("scasplte2", allowAttempt(user.username));
      break;

    case "!visitprofoak":
      newUser(user["display-name"]);
      client.action(
        "scasplte2",
        `Thanks for registering your Pokedex ${
          user["display-name"]
        }! You can view it's contents using !pokedex`
      );
      console.log(getUser(user["display-name"]));
      break;

    case "!pokedex":
      console.log(
        db
          .get("user")
          .find({ name: user["display-name"] })
          .value()
      );
      client.action("scasplte2", ``);
      break;

    // A wild pokemon will appear if a chat message has been sent within 1 second of a 15 minute interval
    default:
      //if (Date.now() % (0.2 * 60 * 1000) < 1000) {
      if (user["display-name"] === "scasplte2") {
        const wildPoke = readPoke(getRandomInt(151));
        updateCatchablePokemon(wildPoke);
        client.action("scasplte2", `A wild ${wildPoke} appeared!`);
      }
  }
});

// function add() {
//     db.get('items')
//       .push({ time: Date.now() })
//       .write()
//   }
// function read() {
//   const state = db.getState();
//   return (str = JSON.stringify(state, null, 2));
// }
// function reset() {
//   db.set("items", []).write();
// }

//   if (user["display-name"] === "scasplte2") {
//     client.action(
//       "scasplte2",
//       `Hello scasplte2! I hear you are talking about me?`
//     );
//   }
//   if (message === "!add") {
//     add();
//   }
//   if (message === "!reset") {
//     reset();
//   }
// TODO: adding ACTION before the message in IRC chat for some reason
//   if (message === "!read") {
//     client.action("scasplte2", `The new db state is: ${read()}`);
//   }
//   client.action("scasplte2", `Hello ${user["display-name"]}!`);
