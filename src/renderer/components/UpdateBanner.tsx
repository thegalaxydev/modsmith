import { useAsync, useStore } from '../store';
import { Ico } from '../ui/icons';
import { IconButton } from '../ui/controls';
import { assetFor, dismissUpdate, isDismissed } from '../updates';
import { PRODUCT } from '../../shared/product';

export function UpdateBanner() {
  const update = useStore((s) => s.update);
  const dismissedNow = useStore((s) => s.updateDismissed);
  const shell = useAsync(() => window.workbench?.info() ?? Promise.resolve(null), []);
  if (!update?.available || !update.latest || dismissedNow === update.latest || isDismissed(update.latest)) return null;
  const asset = assetFor(update, shell.data?.platform ?? '');
  const open = (url: string) => void window.workbench?.openExternal(url);
  return (
    <div className="update-banner" role="status">
      <Ico name="info" />
      <span className="grow">
        {PRODUCT.name} {update.latest} is available. You have {update.current}.
      </span>
      {asset && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => open(asset.url)}>
          <Ico name="external" size={16} />
          Download
        </button>
      )}
      <button type="button" className="btn btn-default btn-sm" onClick={() => open(update.url)}>
        What's new
      </button>
      <IconButton icon="close" label="Dismiss until the next version" onClick={() => dismissUpdate(update.latest)} />
    </div>
  );
}
