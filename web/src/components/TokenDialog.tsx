import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { KeyRoundIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { readToken, setManualTokenPrompt, setTokenPrompt, writeToken } from "@/lib/api.ts"
import { COPY } from "@/lib/copy.ts"

type PendingPrompt = {
  promise: Promise<string | null>
  resolve: (token: string | null) => void
  /** True when a request hit a 401 and will retry itself with the saved token. */
  fromRequest: boolean
}

type TokenDialog = { openDialog: () => void }

const TokenDialogContext = createContext<TokenDialog | null>(null)

/** The header's token button lives under the gate, so it reads the opener from context. */
export function useTokenDialog(): TokenDialog {
  const value = useContext(TokenDialogContext)
  if (value === null) throw new Error("useTokenDialog used outside TokenGate")
  return value
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
  /** Set only when a request was rejected, so the dialog can say why it appeared. */
  const [rejected, setRejected] = useState(false)

  const openPrompt = useCallback((fromRequest: boolean): Promise<string | null> => {
    const inFlight = pending.current
    if (inFlight !== null) {
      // A request-driven prompt is the one that matters: it keeps its retry.
      if (fromRequest) inFlight.fromRequest = true
      setRejected(fromRequest)
      return inFlight.promise
    }
    let resolve: (token: string | null) => void = () => {}
    const promise = new Promise<string | null>((settle) => {
      resolve = settle
    })
    pending.current = { promise, resolve, fromRequest }
    setValue(readToken())
    setRejected(fromRequest)
    setOpen(true)
    return promise
  }, [])

  const requestToken = useCallback((): Promise<string | null> => openPrompt(true), [openPrompt])

  const finish = useCallback(
    (token: string | null) => {
      const entry = pending.current
      pending.current = null
      setOpen(false)
      setRejected(false)
      const saved = token !== null && token.length > 0
      if (saved) writeToken(token)
      /**
       * A request-driven prompt needs no invalidation: every call that saw a 401
       * is awaiting this promise and retries itself with the new token. A prompt
       * opened from the sidebar has nobody to retry for it — the queries that
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

  const context = useMemo<TokenDialog>(
    () => ({ openDialog: () => void openPrompt(false) }),
    [openPrompt]
  )

  return (
    <TokenDialogContext.Provider value={context}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) finish(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
              {COPY.token.title}
            </DialogTitle>
            <DialogDescription>{rejected ? COPY.token.reject : COPY.token.intro}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              finish(value.trim())
            }}
          >
            <Field>
              <FieldLabel htmlFor="admin-token">{COPY.token.label}</FieldLabel>
              <Input
                id="admin-token"
                type="password"
                className="font-mono"
                value={value}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={COPY.token.placeholder}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
              <FieldDescription>{COPY.token.hint}</FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(null)}>
                {COPY.action.cancel}
              </Button>
              <Button type="submit">{COPY.token.submit}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TokenDialogContext.Provider>
  )
}
