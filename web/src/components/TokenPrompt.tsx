import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { readToken, setManualTokenPrompt, setTokenPrompt, writeToken } from "../lib/api.ts"
import { Modal } from "./ui.tsx"

type PendingPrompt = {
  promise: Promise<string | null>
  resolve: (token: string | null) => void
  /** True when a request hit a 401 and will retry itself with the saved token. */
  fromRequest: boolean
}

/**
 * Registers the 401 handler the API client calls. Concurrent 401s share one
 * dialog, so N failing queries produce a single prompt whose token they all
 * retry with; the whole batch still costs one manual entry.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const pending = useRef<PendingPrompt | null>(null)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")

  const openPrompt = useCallback((fromRequest: boolean): Promise<string | null> => {
    const inFlight = pending.current
    if (inFlight !== null) {
      // A request-driven prompt is the one that matters: it keeps its retry.
      if (fromRequest) inFlight.fromRequest = true
      return inFlight.promise
    }
    let resolve: (token: string | null) => void = () => {}
    const promise = new Promise<string | null>((settle) => {
      resolve = settle
    })
    pending.current = { promise, resolve, fromRequest }
    setValue(readToken())
    setOpen(true)
    return promise
  }, [])

  const requestToken = useCallback((): Promise<string | null> => openPrompt(true), [openPrompt])

  const finish = useCallback(
    (token: string | null) => {
      const entry = pending.current
      pending.current = null
      setOpen(false)
      const saved = token !== null && token.length > 0
      if (saved) writeToken(token)
      /**
       * A request-driven prompt needs no invalidation: every call that saw a 401
       * is awaiting this promise and retries itself with the new token. A prompt
       * opened from the header has nobody to retry for it — the queries that
       * failed are already settled in `error` state — so refetching them is the
       * only thing that can pick the token up. Refetching only failed queries
       * also means a wrong token cannot start a second round of 401s.
       */
      if (saved && entry !== null && !entry.fromRequest) void client.invalidateQueries()
      entry?.resolve(token)
    },
    [client]
  )

  useEffect(() => {
    setTokenPrompt(requestToken)
    setManualTokenPrompt(() => {
      void openPrompt(false)
    })
    return () => {
      setTokenPrompt(null)
      setManualTokenPrompt(null)
    }
  }, [requestToken, openPrompt])

  return (
    <>
      {children}
      {open ? (
        <Modal
          title="Admin token required"
          onClose={() => finish(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => finish(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => finish(value.trim())}>
                Save and retry
              </button>
            </>
          }
        >
          <p className="muted">
            The admin API rejected the request with <code>401</code>. Paste the token configured as{" "}
            <code>admin_token</code> in the gateway config.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              finish(value.trim())
            }}
          >
            <label className="field">
              <span className="field-label">Admin token</span>
              <input
                type="password"
                className="input mono"
                value={value}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="admin_token"
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            </label>
            <button type="submit" className="visually-hidden">
              Save
            </button>
          </form>
          <p className="muted small">Stored in this browser only, as localStorage["agg2api.token"].</p>
        </Modal>
      ) : null}
    </>
  )
}
