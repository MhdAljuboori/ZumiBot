import { useRef, useState, type DragEvent, type ReactNode } from 'react'

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

/** Wraps a screen: files dropped anywhere on it go to onFiles, with an overlay while a file drag is over it. */
export function DropZone({
  onFiles,
  className,
  testId,
  children
}: {
  onFiles: (files: File[]) => void
  className?: string
  testId?: string
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  // dragenter/dragleave also fire for every child crossed, so count them instead of trusting one leave.
  const depth = useRef(0)
  return (
    <section
      className={className ? `drop-zone ${className}` : 'drop-zone'}
      data-testid={testId}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        depth.current++
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) onFiles(files)
      }}
    >
      {children}
      {over && (
        <div className="drop-overlay" data-testid="drop-overlay">
          Drop files to attach
        </div>
      )}
    </section>
  )
}
