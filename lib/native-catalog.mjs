/** Apply only after an authenticated native broker provided this capability. */
export function nativeCatalogPrompt(prompt, catalog) {
  if (!catalog) return prompt;
  if (
    catalog.version !== 1 ||
    !/^opencode_skills(?:_(?:[2-9]|[1-9][0-9]+))?$/.test(catalog.serverName)
  )
    throw new Error("Unsupported native skill catalog.");
  const tool = `mcp__${catalog.serverName}__read_skill`;
  const hostNote = catalog.hostSkills?.length
    ? `\nHost skills for this request (use these exact namespaced IDs with ${tool}; use mcp__${catalog.serverName}__list_skills to list them again):\n${catalog.hostSkills.map((skill) => JSON.stringify({ id: skill.id, name: skill.name, description: skill.description })).join("\n")}\n`
    : "";
  const operationsNote = catalog.operations?.length
    ? `\nNamed native OpenCode operations available through MCP (discover their actual schemas): ${catalog.operations.map((name) => `mcp__${catalog.serverName}__${name}`).join(", ")}. rename_current_session only affects this request's session; worktree operations use this project and removal requires this session's ownership. These are MCP tools. JavaScript tools.opencode calls, session move and MCP resource list/read are unavailable in this relay.\n`
    : "";
  const unavailableNote = catalog.unavailableHosts?.length
    ? `\nOptional host skill catalogs unavailable for this request: ${catalog.unavailableHosts.map((name) => JSON.stringify(name)).join(", ")}.\n`
    : "";
  const note = `# Native tool access\n\nUse Claude Code's actual tool catalog. OpenCode's JavaScript execute/search runtime and tools.opencode session, model, worktree and MCP-resource APIs are not exposed on this native route. Do not attempt those calls. Native Agent and Workflow retain their native behavior.\n\nLoad the OpenCode skills advertised below with ${tool}({"id":"<exact advertised id>"}); discover it with ToolSearch if deferred. This performs the OpenCode skill permission check and returns the original skill body and base directory. Claude's Skill tool has its own catalog; a matching name there can have different content. For host skills exposed by another MCP server, discover that server's actual list_skills/read_skill tools and use their declared schemas.\n`;
  const adapt = (text) => {
    const boundary = text.search(/<conversation_history>|<current_turn>/);
    const instructions = boundary < 0 ? text : text.slice(0, boundary);
    const history = boundary < 0 ? "" : text.slice(boundary);
    const transformed = instructions
      .replace(
        /^# Code Mode\r?\n[\s\S]*?(?=\r?\nSkills provide specialized instructions|\r?\n# [^#]|\r?\nInstructions from:|\r?\nToday's date:|(?![\s\S]))/m,
        note + "\n",
      )
      .replaceAll(
        "Use the skill tool to load a skill when a task matches its description.",
        `Use ${tool} with the advertised skill id when a task matches its description.`,
      )
      .replace(
        /^When you create a worktree outside the current working directory.*tools\.opencode\.session_move.*$/gm,
        "OpenCode session relocation is unavailable through this native tool catalog.",
      );
    return (
      (transformed.includes(note) ? transformed : `${note}\n${transformed}`) +
      hostNote +
      operationsNote +
      unavailableNote +
      history
    );
  };
  if (typeof prompt === "string") return adapt(prompt);
  // Preserve images and all user/history text. Only instruction blocks contain
  // the generated Code Mode heading and catalog loader sentence.
  let found = false;
  const blocks = prompt.map((block) => {
    if (block.type !== "text" || !/^SYSTEM:|^DEVELOPER:/.test(block.text)) return block;
    found = true;
    return { ...block, text: adapt(block.text) };
  });
  return found
    ? blocks
    : [{ type: "text", text: note + hostNote + operationsNote + unavailableNote }, ...blocks];
}
