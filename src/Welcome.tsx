/**
 * The welcome a captain meets on the app's own home until their first mate has answered there: the agents on this Mac,
 * what each is missing, and the ways through it. Detect, then consent, then install: every command shows before it runs,
 * and a click on Install is consent to exactly those. Its states are checked by `pnpm welcome`.
 */
import { useState } from "react";

import { agentPills, agentRole, cannotInstall, firstMateNote, installSteps, nodeShortfall, startBlocker, type InstallView } from "./agents";
import type { AgentId, AgentStatus, OnboardingStatus } from "./host/types";

const ACCOUNTS: Record<AgentId, string> = {
  claude: "A Claude plan or an Anthropic Console account both work.",
  codex: "A ChatGPT plan or an OpenAI API key both work.",
};

const GLYPH: Record<AgentId, string> = { claude: "C", codex: "X" };

/** The agents looked for before anything is known, so the screen has the shape it will have. */
const LOOKING: { id: AgentId; label: string }[] = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }];

/** Everything the agent list needs: the agents, what the captain is doing with them, and the ways through. */
export type AgentListProps = {
  status: OnboardingStatus | null;
  checking: boolean;
  problem: string | null;
  installs: Partial<Record<AgentId, InstallView>>;
  /** Open in Terminal, and `still-out` once the captain said they had signed in and the agent still said no. */
  signingIn: Partial<Record<AgentId, boolean | "still-out">>;
  choosing: boolean;
  onCheck: () => void;
  onInstall: (agent: AgentId) => void;
  onSignIn: (agent: AgentId) => void;
  onConfirmSignIn: (agent: AgentId) => void;
  onChoose: (agent: AgentId) => void;
};

export type WelcomeProps = AgentListProps & { onMeet: () => void };

export function Welcome(props: WelcomeProps) {
  const { status } = props;
  const blocker = status ? startBlocker(status) : null;
  const chosen = status?.agents.find((agent) => agent.id === status.firstMate);
  const others = status?.agents.filter((agent) => agent.installed && agent.id !== status.firstMate) ?? [];
  const nothingHere = status !== null && status.agents.length > 0 && status.agents.every((agent) => !agent.installed);
  const footer = !status ? "Nothing is installed without your OK."
    : blocker ?? `Your first mate runs on ${chosen?.label}. ${others.length ? `It hands work to ${[chosen?.label, ...others.map((agent) => agent.label)].join(" or ")}.` : `It hands work to ${chosen?.label}.`}`;
  return <div className="home-setup welcome-screen" data-screen="welcome">
    <section>
      <div className="brand-mark">Q</div>
      <h1>Welcome aboard</h1>
      <p>{nothingHere
        ? "Your first mate runs on an AI coding agent, and this Mac has none yet. Install one, or both."
        : "Your first mate plans work across your projects, hands it to crewmates, and brings you only the calls that are yours. It runs on an AI coding agent, and so does its crew."}</p>
      <AgentList {...props} />
      <footer className="welcome-footer">
        <small>{footer}</small>
        <button className="home-choose welcome-meet" disabled={!status || blocker !== null} onClick={props.onMeet}>Meet your first mate</button>
      </footer>
    </section>
  </div>;
}

/** The agents on this Mac, one row each, from firstmate's own list: shared by the welcome and Settings. */
export function AgentList(props: AgentListProps) {
  const { status } = props;
  return <>
    {props.problem && <div className="welcome-problem" role="alert"><span>{props.problem}</span><button className="btn-quiet" onClick={props.onCheck} disabled={props.checking}>Check again</button></div>}
    {status?.problem && <div className="welcome-problem" role="alert"><span>{status.problem}</span><button className="btn-quiet" onClick={props.onCheck} disabled={props.checking}>Check again</button></div>}
    <ul className="agent-list" aria-label="Agents on this Mac" aria-busy={!status}>
      {status
        ? status.agents.map((agent) => <AgentRow key={agent.id} {...props} agent={agent} status={status} />)
        : LOOKING.map((agent) => <li key={agent.id} className="agent-row"><span className="agent-glyph">{GLYPH[agent.id]}</span><div><strong>{agent.label}</strong><span className="agent-facts"><span className="pill wait"><i className="spinner" />Looking…</span></span></div></li>)}
    </ul>
  </>;
}

function AgentRow({ agent, status, installs, signingIn, choosing, onCheck, onInstall, onSignIn, onConfirmSignIn, onChoose }: AgentListProps & { agent: AgentStatus; status: OnboardingStatus }) {
  const firstMate = status.firstMate;
  const mine = agent.id === firstMate;
  // The first mate's agent opens with what installing it would run; another waits to be asked.
  const [open, setOpen] = useState(mine);
  const [everything, setEverything] = useState(false);
  const install = installs[agent.id];
  const steps = installSteps(agent, firstMate);
  const node = nodeShortfall(agent, firstMate, status.node);
  const waiting = signingIn[agent.id] !== undefined && signingIn[agent.id] !== false;
  const stillOut = signingIn[agent.id] === "still-out";
  const role = agentRole(agent, firstMate);
  const note = mine ? firstMateNote(agent.id) : null;
  const needsSetup = steps.length > 0;
  const bad = (install?.state === "failed") || (mine && (needsSetup || agent.signedIn === "signed-out") && !waiting && install?.state !== "running");

  let body: React.ReactNode = null;
  if (install?.state === "running") {
    body = <>{install.line && <span className="agent-out">{install.line}</span>}</>;
  } else if (install?.state === "failed") {
    body = <>
      <span className="agent-says">{install.steps > 0 ? `${install.title} stopped before it finished${install.step > 1 ? ", after the steps before it had worked" : ""}.` : "The install could not start."}</span>
      {install.error && <span className="agent-out">{install.error}</span>}
      {everything && install.lines.length > 0 && <pre className="agent-log">{install.lines.join("\n")}</pre>}
      <span className="row-actions">
        {install.lines.length > 0 && <button className="btn-quiet" onClick={() => setEverything((current) => !current)}>{everything ? "Hide what it said" : "Show everything it said"}</button>}
        <button className="btn-heavy" onClick={() => onInstall(agent.id)}>Try again</button>
      </span>
    </>;
  } else if (cannotInstall(agent)) {
    body = <span className="agent-says">firstmate knows no way to install {agent.label}, so it has to be installed by hand.</span>;
  } else if (needsSetup && (open || mine)) {
    body = node
      ? <>
        <span className="agent-says">{node.have
          ? `This Mac has Node ${node.have.replace(/^v/, "")}, and installing this needs ${node.floor} or newer.`
          : `Installing this needs Node.js ${node.floor} or newer, and this Mac has none. The app can't install Node for you, because it asks for your Mac's password.`}</span>
        {status.brew && <code className="agent-cmd">{node.have ? "brew upgrade node" : "brew install node"}</code>}
        {!node.have && <span className="agent-alt">{status.brew ? "Or use" : "Use"} the installer from <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer noopener">nodejs.org</a>. Then come back here.</span>}
        <span className="row-actions"><button className="btn-heavy" onClick={onCheck}>Check again</button></span>
      </>
      : <>
        <span className="agent-consent">Installing runs {steps.length === 1 ? "this" : "these, in order"}:</span>
        {steps.map((step) => <code key={step.command} className="agent-cmd">{step.command}</code>)}
        <span className="agent-alt">{steps.map((step) => step.title.startsWith("Install the ACP")
          ? `The ACP adapter is how the app talks to ${agent.label}. It goes into the app's own folder, about 300 MB, pinned to the version the app was tested with.`
          : `${steps.length === 1 ? "It is" : "The first is"} ${agent.label}'s own installer.`).join(" ")}</span>
        <span className="row-actions"><button className="btn-heavy" onClick={() => onInstall(agent.id)}>{agent.installed ? "Install the adapter" : `Install ${agent.label}`}</button></span>
      </>;
  } else if (needsSetup) {
    body = <span className="row-actions"><button className="btn-quiet" onClick={() => setOpen(true)}>Install {agent.label}…</button></span>;
  } else if (waiting) {
    body = <>
      <span className="agent-says">{stillOut ? `${agent.label} still says this Mac isn't signed in. Finish in the Terminal window, or open it again.` : "Finish signing in in the Terminal window, then come back."}</span>
      <span className="row-actions"><button className="btn-heavy" onClick={() => onConfirmSignIn(agent.id)}>I've signed in</button><button className="btn-quiet" onClick={() => onSignIn(agent.id)}>Open Terminal again</button></span>
    </>;
  } else if (agent.signedIn === "signed-out") {
    body = <>
      <span className="agent-says">{mine ? `${agent.label}'s own sign-in opens in Terminal. ${ACCOUNTS[agent.id]}` : `Signed out, so it can't take crew work yet. ${ACCOUNTS[agent.id]}`}</span>
      <span className="row-actions"><button className={mine ? "btn-heavy" : "btn-quiet"} onClick={() => onSignIn(agent.id)}>Sign in to {agent.id === "claude" ? "Claude" : agent.label}</button></span>
    </>;
  }

  const pills = agentPills(agent, firstMate);
  const installing = install?.state === "running";
  return <li className={`agent-row ${bad ? "bad" : ""} ${mine && agent.installed ? "chosen" : ""}`} data-agent={agent.id}>
    <span className="agent-glyph">{GLYPH[agent.id]}</span>
    <div>
      <strong>{agent.label}{agent.version && <span className="agent-version">{agent.version}</span>}</strong>
      <span className="agent-facts">
        {pills.filter((pill) => !(installing && pill.tone === "bad") && !(waiting && pill.text === "Not signed in")).map((pill) => <span key={pill.text} className={`pill ${pill.tone}`}>{pill.text}</span>)}
        {installing && <span className="pill wait"><i className="spinner" />{install!.title}{install!.steps > 1 ? `, step ${install!.step} of ${install!.steps}` : ""}</span>}
        {waiting && <span className="pill wait"><i className="spinner" />Signing in, in Terminal</span>}
      </span>
      {body}
      {role && <span className="agent-role">{role}{!mine && <> · <button className="link-button" disabled={choosing || agent.signedIn === "signed-out"} onClick={() => onChoose(agent.id)}>Run the first mate on {agent.label}</button></>}</span>}
      {note && <span className="agent-note">{note}</span>}
    </div>
  </li>;
}
