import { answerConfirm, useUpdate } from '../useUpdate'
import { ConfirmDialog } from './ConfirmDialog'
import { UpdateToast } from './UpdateToast'
import { UpdatingOverlay } from './UpdatingOverlay'

/** The app-level pieces of self-update: the toast, the "replies are running" confirm and the updating overlay. */
export function UpdateHost({ onWhatsNew }: { onWhatsNew: () => void }) {
  const { run, confirm, status } = useUpdate()
  return (
    <>
      <UpdateToast onWhatsNew={onWhatsNew} />
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'install' ? 'Update ZumiBot' : 'Roll back ZumiBot'}
          message={confirm.prompt}
          buttons={[
            {
              label: confirm.stage === 'ask' ? 'Roll back' : confirm.kind === 'install' ? 'Update anyway' : 'Roll back anyway',
              value: 'yes',
              danger: true
            },
            { label: 'Cancel', value: 'no' }
          ]}
          initialFocus="no"
          onResolve={(v) => void answerConfirm(v === 'yes')}
        />
      )}
      {run && <UpdatingOverlay local={status?.local ?? false} />}
    </>
  )
}
