import { useState, type ReactNode } from 'react';
import { store, useAsync, useStore } from '../store';
import { Ico } from '../ui/icons';
import { Button, IconButton } from '../ui/controls';
import { installJava, type JavaNeeds } from '../java';
import { JavaDownloads } from './JavaDownloads';

const KEY = 'mwb.firstRunDismissed';
const ENTRY = 'fabric-1.21.1';

function dismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function Step({ done, title, detail, action }: { done: boolean; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className={`checklist-step ${done ? 'done' : ''}`}>
      <Ico name={done ? 'success' : 'info'} size={18} />
      <span className="col tight grow">
        <b>{title}</b>
        <span className="small dim">{detail}</span>
      </span>
      {action}
    </div>
  );
}

export function FirstRunChecklist({ onSettings, hasProjects }: { onSettings: (tab: string) => void; hasProjects: boolean }) {
  const connection = useStore((s) => s.connection);
  const [hidden, setHidden] = useState(dismissed);
  const [installing, setInstalling] = useState(false);
  const installed = useStore((s) => s.operations.filter((o) => o.kind === 'java.install' && o.status === 'succeeded').length);
  const ready = connection === 'connected';
  const java = useAsync(() => (ready ? store.call<JavaNeeds>('java.requirements', { catalogEntryId: ENTRY }, { quiet: true }) : Promise.resolve(null)), [ready, installed]);
  const providers = useAsync(() => (ready ? store.call<{ providers: { id: string; usable: boolean }[] }>('provider.status', {}, { quiet: true }) : Promise.resolve(null)), [ready]);
  if (hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      void 0;
    }
    setHidden(true);
  };

  const missing = java.data?.install ?? [];
  const found = java.data?.requirements[0]?.java;
  const javaDone = !!java.data && !missing.length;
  const cf = providers.data?.providers.find((p) => p.id === 'curseforge')?.usable ?? false;

  const download = async () => {
    setInstalling(true);
    try {
      for (const n of missing) if (!(await installJava(n.major, n.imageType))) break;
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="checklist" aria-label="Getting started">
      <div className="row">
        <h2 className="grow">Getting started</h2>
        <IconButton icon="close" label="Dismiss getting started" onClick={dismiss} />
      </div>
      <Step
        done={javaDone}
        title="Java"
        detail={
          java.loading
            ? 'Checking installed Java…'
            : javaDone
              ? `Gradle runs on ${found?.vendor ?? 'Java'} ${found?.version ?? ''}. Other Java versions are offered when a project needs them.`
              : `New Fabric ${ENTRY.split('-')[1]} projects need JDK ${missing.map((m) => m.major).join(', ')}. Modsmith can download Eclipse Temurin for you.`
        }
        action={
          !javaDone && !java.loading ? (
            <Button variant="primary" size="sm" icon="download" busy={installing} disabled={!ready} onClick={() => void download()}>
              Download Java {missing.map((m) => m.major).join(', ')}
            </Button>
          ) : undefined
        }
      />
      <JavaDownloads />
      <Step
        done={cf}
        title="CurseForge API key (optional)"
        detail={cf ? 'CurseForge search and downloads are enabled.' : 'Modrinth works without a key. Add your own key to search and download from CurseForge.'}
        action={
          !cf ? (
            <Button size="sm" onClick={() => onSettings('providers')}>
              Add key
            </Button>
          ) : undefined
        }
      />
      <Step done={hasProjects} title="Create, open or import a project" detail="Start a new mod from a verified template, open an existing folder, or import a Modrinth or CurseForge pack with the buttons above." />
    </section>
  );
}
