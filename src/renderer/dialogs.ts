export async function ask(text: string): Promise<boolean> {
  if (window.workbench?.confirm) return window.workbench.confirm(text);
  return (await Promise.resolve(window.confirm(text))) === true;
}

export async function tell(text: string): Promise<void> {
  if (window.workbench?.alert) return window.workbench.alert(text);
  window.alert(text);
}
