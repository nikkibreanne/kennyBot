# kennyBot
A Twitch chat-bot for the nikkibreanne channel at https://twitch.tv/nikkibreanne

This bot is built using tmi.js (https://github.com/tmijs/tmi.js) that currently supports [Node.js 7.x](https://nodejs.org/en/download/). Documentation for tmi.js is supposed to be avialable at https://docs.tmijs.org/ but the link currently seems to be down so the most recent Markdown files can be accessed at https://github.com/tmijs/docs/tree/gh-pages/_posts/v1.4.2

## Install

### Node

```bash
$ npm install
```
The dotenv module (https://github.com/motdotla/dotenv) is used to protect OAuth keys for the chat client

## Running

```bash
$ node index.js
```

Currently in testing phase so the bot targets the channel https://twitch.tv/scasplte2/ but this is may be easily modified in the configuration options.