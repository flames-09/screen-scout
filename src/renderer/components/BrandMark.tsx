/** Screen Scout brand mark — the app logo (S monogram in a viewfinder tile). */
import brandUrl from '../../../assets/brand-128.png'

export function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <img
      src={brandUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', flex: 'none', borderRadius: Math.max(4, size * 0.24) }}
    />
  )
}
