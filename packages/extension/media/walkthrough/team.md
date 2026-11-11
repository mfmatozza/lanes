# Team context and the team app (optional)

Lanes works without this step. Turn it on when you want agents to know what teammates are doing.

- **Lanes: Turn On Team Context** writes `.lanes/team.json` in the repository. Commit it so teammates get it. Agents there then get a short team brief with each prompt (who is working on what, new chat messages) and a one-line heads-up before they edit or read a file a teammate is changing. Edits are never blocked.
- The **Team** view in the Lanes sidebar holds requests waiting for you (Approve or Decline), the requests you sent and the team chat. **Lanes: Message the Team** and **Lanes: Ask a Teammate's Agent** are its title buttons. A request reaches a teammate's agent only after they approve it.
- **Lanes: Open Team App** opens the same team, files, chat and requests in your browser, served by the Lanes server. The link holds your token, so do not share it.
- If your team uses personal tokens, **Lanes: Copy Sign-In Command** copies the line that signs you in with GitHub.
