import { useState } from "react"

/**
 * For a surface drawn by one of several elements (or none), returns the key
 * that appeared while nothing was shown, and null once it has been swapped for
 * another; back to none resets it. Elements that swap remount, so an entrance
 * keyed on this plays when the surface opens and not on every swap (#670).
 */
export function useEntrance<K>(key: K | null): K | null {
  const [prev, setPrev] = useState(key)
  const [entering, setEntering] = useState(key)
  if (key !== prev) {
    setPrev(key)
    setEntering(prev === null ? key : null)
  }
  return entering
}
