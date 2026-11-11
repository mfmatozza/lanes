# The Lanes server

The server only ever sees file paths, names and statuses. File contents never leave your machine.

- **Just you:** you can skip this step. The first Claude Code session starts a server on `127.0.0.1:4317` by itself, and **Lanes: Start Local Server** starts one from VS Code.
- **A team, the person who hosts the server:** run **Lanes: Copy Team Server Command**, paste the line into a terminal on that machine (it needs Node 22.18 or newer), then run **Lanes: Copy Teammate Join Message** and send the message to your teammates. It holds the team token, so send it only to them.
- **A team, everyone else:** run **Lanes: Join Team Server** and paste the address and the token from the message.
