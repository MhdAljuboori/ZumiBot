import { useCallback, useEffect, useRef, useState } from 'react'
import { SEARCH_OFFSET_MAX, parseQuery, type SearchHit, type SearchResult } from '@zumibot/shared/search'
import { SEARCH_DEBOUNCE_MS, SEARCH_INDEXING_RETRY_MS, addPage } from '../state/messageSearch'
import { api } from '../api'

export interface MessageSearch {
  /** The hits listed so far, newest first. */
  hits: SearchHit[]
  /** The latest page's counts; null before the first answer for this query. */
  result: SearchResult | null
  loading: boolean
  failed: boolean
  /** Asks for the next page; nothing while one is out or there is none. */
  more: () => void
}

/**
 * The server's message hits for the sidebar's search box: asked once typing pauses, for a query that holds a word. An
 * answer for an older query never lands; a next page adds to what is listed. While the server is still indexing, the
 * first page is asked again until it is done, so older chats' hits fill in.
 */
export function useMessageSearch(query: string, connected: boolean): MessageSearch {
  const [hits, setHits] = useState<SearchHit[]>([])
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const paging = useRef(false)
  const q = query.trim()
  const active = connected && parseQuery(q) !== null

  useEffect(() => {
    const mine = ++seq.current
    paging.current = false
    setHits([])
    setResult(null)
    setFailed(false)
    setLoading(active)
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      api.chats.search(q, 0).then(
        (r) => {
          if (mine !== seq.current) return
          // A retry while indexing replaces the first page; pages added meanwhile are dropped with it.
          setHits(r.hits)
          setResult(r)
          setLoading(false)
          if (r.indexing) timer = setTimeout(ask, SEARCH_INDEXING_RETRY_MS)
        },
        () => {
          if (mine !== seq.current) return
          setLoading(false)
          setFailed(true)
        }
      )
    }
    timer = setTimeout(ask, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, active])

  const more = useCallback(() => {
    if (paging.current || !result?.more || hits.length > SEARCH_OFFSET_MAX) return
    const mine = seq.current
    paging.current = true
    setLoading(true)
    api.chats.search(q, hits.length).then(
      (r) => {
        if (mine !== seq.current) return
        paging.current = false
        setHits((held) => addPage(held, r.hits))
        setResult(r)
        setLoading(false)
      },
      () => {
        if (mine !== seq.current) return
        paging.current = false
        setLoading(false)
        setFailed(true)
      }
    )
  }, [q, result, hits.length])

  return { hits, result, loading, failed, more }
}
