import { WEBCAMS } from '../data/webcams'
import { CameraIcon } from './Icons'

/** "Live webcams" pill for a resort; renders nothing for places without cams. */
export function WebcamLink({ id }: { id: string }) {
  const webcam = WEBCAMS[id]
  if (!webcam) return null
  return (
    <a className="webcam-link" href={webcam.url} target="_blank" rel="noopener noreferrer">
      <CameraIcon />
      <span>Live webcams</span>
      <span className="webcam-source">{webcam.source ?? 'official'} ↗</span>
    </a>
  )
}
