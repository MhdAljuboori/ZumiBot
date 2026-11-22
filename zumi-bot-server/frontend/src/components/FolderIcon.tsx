// Font Awesome Free 6.7.2 "folder" (regular) by @fontawesome - https://fontawesome.com
// License - https://fontawesome.com/license/free (Icons: CC BY 4.0). Copyright 2024 Fonticons, Inc.
const FOLDER_PATH =
  'M0 96C0 60.7 28.7 32 64 32l132.1 0c19.1 0 37.4 7.6 50.9 21.1L289.9 96 448 96c35.3 0 64 28.7 64 64l0 256c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96zM64 80c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l384 0c8.8 0 16-7.2 16-16l0-256c0-8.8-7.2-16-16-16l-161.4 0c-10.6 0-20.8-4.2-28.3-11.7L213.1 87c-4.5-4.5-10.6-7-17-7L64 80z'

/** The one folder icon used wherever a chat's folder shows; sized by the surrounding font (1em). */
export function FolderIcon() {
  return (
    <svg className="folder-icon" viewBox="0 0 512 512" aria-hidden="true">
      <path fill="currentColor" d={FOLDER_PATH} />
    </svg>
  )
}
