require("dotenv").config();
const tmi = require("tmi.js");
const low = require("lowdb");
const lodashId = require("lodash-id");
const FileSync = require("lowdb/adapters/FileSync");

// LocalStorage is a lowdb adapter for saving to localStorage
const adapter = new FileSync("db.json");
// Create database instance
const db = low(adapter);
db._.mixin(lodashId);

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
db.defaults({ pokemon: [], users: [], catchablePokemon: "" }).write();

// Define functions
function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

function getUserRecord(_username) {
  return db.get("users").find({ username: _username });
}

function pickPokemon(pokeID) {
  const poke = db
    .get("pokemon")
    .find({ id: pokeID })
    .value();
  return poke.name;
  //   return (str = JSON.stringify(poke.name, null, 2));
}

function addPokemonToUser(_username, _pokemon) {
  getUserRecord(_username)
    .value()
    .pokemon.push(_pokemon);
}

function releasePokemon(_username, _pokemon) {
  getUserRecord(_username)
    .value()
    .pokemon.pop(_pokemon);
}

function updateCatchablePokemon(wildPokemon) {
  db.set("catchablePokemon", wildPokemon).write();
}

function getUserPokemon(_username) {
  let msg = "";
  if (isUserInDB(_username)) {
    msg = `${_username} you currently have ${JSON.stringify(
      getUserRecord(_username).value().pokemon
    )}`;
  } else {
    msg = `Silly ${_username}. You must visit Professor Oak ( !visitprofoak ) to register your Pokedex to have Pokemon.`;
  }
  return msg;
}

function isUserInDB(_username) {
  let existingUser = false;
  if (getUserRecord(_username).value()) {
    existingUser = true;
  }
  return existingUser;
}

function newUser(_username) {
  let msg = "";
  if (isUserInDB(_username)) {
    msg = `${_username}, you're already registered! Get out there and catch em' all!`;
  } else {
    db.get("users")
      .insert({ username: _username, pokemon: [] })
      .write();
    msg = `Thanks for registering your Pokedex ${_username}! You can view it's contents using !pokedex`;
  }
  return msg;
}

// function to check if the user is registered and to attempt catch if so
function allowAttempt(_username) {
  let msg = "";
  if (isUserInDB(_username)) {
    msg = attemptCatch(_username);
  } else {
    msg = `Sorry ${_username}, please visit Professor Oak ( !visitprofoak ) to register your Pokedex before attempting to catch Pokemon.`;
  }
  return msg;
}

// function to compute the catch attempt
function attemptCatch(_username) {
  // Retrieve catchable pokemon for convenience
  const wildPokemon = db.get("catchablePokemon").value();
  // calculate normalization (makes catching more variable)
  //const normalization = getRandomInt(12);
  const normalization = 1;
  // calculate attempt
  const attempt = getRandomInt(100);
  // check if the pokemon was caught
  let msg = "";
  if (wildPokemon) {
    if (attempt < 100 / normalization) {
      msg = `Congratulations ${_username}! You caught a ${wildPokemon}.`;
      addPokemonToUser(_username, wildPokemon);
    } else {
      msg = `Your pokeball missed ${_username}! You scared away the ${wildPokemon}.`;
    }
    // always clear out the wild pokemon after an attempt
    updateCatchablePokemon("");
  } else {
    msg = `Sorry ${_username}. There are currently no wild pokemon around to catch.`;
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
      client.action("scasplte2", newUser(user["display-name"]));
      break;

    case "!pokedex":
      client.action("scasplte2", getUserPokemon(user["display-name"]));
      break;

    // A wild pokemon will appear if a chat message has been sent within 1 second of a 15 minute interval
    default:
      //if (Date.now() % (0.2 * 60 * 1000) < 1000) {
      if (user["display-name"] === "scasplte2") {
        const wildPoke = pickPokemon(getRandomInt(151));
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
