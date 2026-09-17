/**
 * The diagram a page owns, opened for real.
 *
 * A page ships its diagram as a scene file plus a picture of it, so the page
 * stays a plain picture anywhere else. Here the scene itself opens in an editor,
 * and what the captain leaves becomes a proposal in the review: the author's next
 * revision is still the only thing that changes the page.
 *
 * Excalidraw is loaded only when a diagram is opened, so the rest of the app does
 * not carry it.
 */
import "@excalidraw/excalidraw/index.css";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const Excalidraw = lazy(() => import("@excalidraw/excalidraw").then((module) => ({ default: module.Excalidraw })));

type SceneElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  isDeleted?: boolean;
  containerId?: string | null;
};

export type ScenePlace = { file: string; label: string; path: string };
export type SceneProposal = { summary: string; scene: string; png: string };

/** What a label says, whether it is the element's own text or the text bound to it. */
function labelOf(element: SceneElement, all: SceneElement[]) {
  if (element.text?.trim()) return element.text.trim();
  const bound = all.find((candidate) => candidate.containerId === element.id && candidate.text?.trim());
  return bound?.text?.trim() ?? "";
}

function name(element: SceneElement, all: SceneElement[]) {
  const label = labelOf(element, all);
  return label ? `${element.type} “${label}”` : element.type;
}

/**
 * What changed, in the diagram's own terms rather than pixels: an author reading
 * this should know what to draw without opening the scene file.
 */
export function describeChanges(before: SceneElement[], after: SceneElement[]) {
  const live = (elements: SceneElement[]) => elements.filter((element) => !element.isDeleted && element.type !== "text");
  const was = live(before);
  const now = live(after);
  const lines: string[] = [];
  for (const element of now) {
    const previous = was.find((candidate) => candidate.id === element.id);
    if (!previous) {
      lines.push(`Added ${name(element, after)}`);
      continue;
    }
    const moved = Math.round(element.x - previous.x) !== 0 || Math.round(element.y - previous.y) !== 0;
    const resized = Math.round(element.width - previous.width) !== 0 || Math.round(element.height - previous.height) !== 0;
    const relabelled = labelOf(previous, before) !== labelOf(element, after);
    if (relabelled) lines.push(`Renamed ${name(previous, before)} to “${labelOf(element, after)}”`);
    else if (moved && resized) lines.push(`Moved and resized ${name(element, after)}`);
    else if (moved) lines.push(`Moved ${name(element, after)}`);
    else if (resized) lines.push(`Resized ${name(element, after)}`);
  }
  for (const element of was) {
    if (!now.some((candidate) => candidate.id === element.id)) lines.push(`Removed ${name(element, before)}`);
  }
  return lines;
}

export function SceneEditor({ place, scene, onClose, onPropose }: {
  place: ScenePlace;
  scene: { elements: SceneElement[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
  onClose: () => void;
  onPropose: (proposal: SceneProposal) => Promise<unknown>;
}) {
  const api = useRef<any>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const before = useMemo(() => scene.elements ?? [], [scene]);

  const propose = useCallback(async () => {
    if (!api.current) return;
    setSaving(true);
    setProblem(null);
    try {
      const elements = api.current.getSceneElements() as SceneElement[];
      const lines = describeChanges(before, elements);
      if (lines.length === 0) {
        setProblem("Nothing has changed in this diagram yet.");
        setSaving(false);
        return;
      }
      const appState = api.current.getAppState();
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true, viewBackgroundColor: "#ffffff" },
        files: api.current.getFiles(),
        mimeType: "image/png",
        quality: 0.92,
      });
      const png = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(blob);
      });
      await onPropose({
        summary: `${lines.length === 1 ? "1 change" : `${lines.length} changes`} to ${place.label}: ${lines.join("; ")}.`,
        scene: JSON.stringify({ type: "excalidraw", version: 2, source: "quarterdeck", elements, appState: { viewBackgroundColor: "#ffffff" }, files: api.current.getFiles() }),
        png,
      });
      onClose();
    } catch (error) {
      setProblem(String(error));
    } finally {
      setSaving(false);
    }
  }, [before, onClose, onPropose, place.label]);

  return <div className="scene-backdrop" role="dialog" aria-label={`${place.label} diagram`}>
    <section className="scene-editor">
      <header>
        <div><span>Diagram</span><h2>{place.label}</h2></div>
        <p>What you change here goes to the author as a proposal, with your review.</p>
        <button className="icon-button" onClick={onClose} title="Close without proposing"><X size={18} /></button>
      </header>
      <div className="scene-canvas">
        <Suspense fallback={<div className="scene-loading">Opening the diagram…</div>}>
          <Excalidraw
            excalidrawAPI={(instance: unknown) => { api.current = instance; }}
            initialData={{ elements: before as never, appState: { viewBackgroundColor: "#ffffff", ...(scene.appState ?? {}) } as never, files: (scene.files ?? {}) as never, scrollToContent: true }}
          />
        </Suspense>
      </div>
      <footer>
        {problem && <p className="scene-problem" role="alert">{problem}</p>}
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button disabled={saving} onClick={() => void propose()}>{saving ? "Saving…" : "Propose these changes"}</button>
      </footer>
    </section>
  </div>;
}
