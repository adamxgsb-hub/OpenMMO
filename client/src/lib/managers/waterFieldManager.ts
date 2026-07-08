import { getTerrainApiUrl } from '../utils/networkUtils'
import {
  decodeWaterFieldData,
  type WaterFieldTileData,
} from '../utils/water-field-data'
import { tileKey } from './terrain-height-types'

/** Per-tile WFD1 fetcher + decoder. Mirrors the pattern of the other
 *  per-tile binary loaders (grass / trees / splat) — fetch once, cache,
 *  return decoded channels. A 404 means "no river influence in this
 *  tile"; the water layer synthesizes a flat sea field for those.
 *  Texture construction lives in `water-quad-geometry.ts` next to the
 *  geometry helper. */
export class WaterFieldManager {
  private cache = new Map<string, WaterFieldTileData | null>()
  private inflight = new Map<string, Promise<WaterFieldTileData | null>>()
  private terrainApiUrl = getTerrainApiUrl()

  async loadWaterField(
    tileX: number,
    tileZ: number
  ): Promise<WaterFieldTileData | null> {
    const key = tileKey(tileX, tileZ)

    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const existing = this.inflight.get(key)
    if (existing) return existing

    const promise = (async () => {
      try {
        const url = `${this.terrainApiUrl}/api/terrain/water-field/${tileX}/${tileZ}`
        const response = await fetch(url)
        if (response.status === 404) {
          this.cache.set(key, null)
          return null
        }
        if (!response.ok) {
          console.error(
            `Failed to load water field (${tileX}, ${tileZ}): ${response.status}`
          )
          return null
        }
        const buffer = await response.arrayBuffer()
        const data = decodeWaterFieldData(buffer)
        this.cache.set(key, data)
        return data
      } catch (e) {
        console.error(`Water field fetch error (${tileX}, ${tileZ}):`, e)
        return null
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, promise)
    return promise
  }
}
