import type { SideQuestion } from '@zumibot/shared/btw'
import { attachmentUrl } from '@zumibot/shared/attachments'
import type { DesktopBridge } from '@zumibot/shared/desktop'
import type { IslandBridge } from '@zumibot/shared/island'
import type { NotifyClear, NotifyPayload } from '@zumibot/shared/notify'
import type { RoutinesSnapshot } from '@zumibot/shared/routines'
import type { SidebarLayout } from '@zumibot/shared/sidebarLayout'
import type { AgentRename, ZumiBotApi, WirePush } from '@zumibot/shared/types'
import type { VoiceStatus } from '@zumibot/shared/voice'
import type { UpdateStatus } from '@zumibot/shared/update'
import type { WorkflowsSnapshot } from '@zumibot/shared/workflows'
import type { RpcClient } from './rpc'
import { redirectToLogin } from './signedOut'
import { uploadFile } from './upload'

export type FolderPickerOpener = (start: string) => Promise<string | null>

interface FolderStart {
  fixed: boolean
  path: string
}

export function createApi(
  rpc: RpcClient,
  o: {
    fetch: typeof fetch
    desktop: DesktopBridge | null
    /** The island window's bridge, which opens attachments through the shell when there is no `desktop`. */
    island?: IslandBridge | null
    openWindow(url: string): void
    folderPicker: FolderPickerOpener
    /** Installs (or with null removes) the browser's leave-page warning. */
    setBeforeUnload?(handler: ((e: BeforeUnloadEvent) => string) | null): void
    assignLocation?(url: string): void
  }
): ZumiBotApi {
  const call = <T>(method: string, ...args: unknown[]): Promise<T> => rpc.call(method, args) as Promise<T>
  const logout = async (path: string): Promise<void> => {
    await o.fetch(path, { method: 'POST' })
    redirectToLogin(o.assignLocation, false) // the user chose to leave: keep no drafts
  }

  return {
    btw: {
      ask: (chatId, question, id) => call('btw:ask', chatId, question, id),
      follow: (chatId, threadId, question, id) => call('btw:follow', chatId, threadId, question, id),
      list: (chatId) => call('btw:list', chatId),
      stop: (chatId, id) => call('btw:stop', chatId, id),
      again: (chatId, id) => call('btw:again', chatId, id),
      onChanged: (cb) => rpc.on('btw:changed', (p: { chatId: string; entry: SideQuestion }) => cb(p))
    },
    browsers: {
      status: (agent) => call('browsers:status', agent),
      clear: (agent) => call('browsers:clear', agent)
    },
    // Status never starts a desktop; clear stops it and deletes its home folder. The live view has its own socket.
    desktops: {
      status: (agent) => call('desktops:status', agent),
      clear: (agent) => call('desktops:clear', agent)
    },
    codexInfo: () => call('agents:codexInfo'),
    agents: {
      list: () => call('agents:list'),
      read: (filePath) => call('agents:read', filePath),
      save: (originalFilePath, raw) => call('agents:save', originalFilePath, raw),
      trash: (filePath) => call('agents:trash', filePath),
      onChanged: (cb) => rpc.on('agents:changed', (r: AgentRename[] | undefined) => cb(r ?? [])),
      testAcp: (agentName) => call('agents:testAcp', agentName),
      acpLaunch: (agentName) => call('agents:acpLaunch', agentName),
      testAgui: (agentName) => call('agents:testAgui', agentName),
      aguiLaunch: (agentName) => call('agents:aguiLaunch', agentName),
      engineCommands: (agent, folder) => call('agents:engineCommands', agent, folder)
    },
    chats: {
      list: () => call('chats:list'),
      create: (agentName, cwd) => call('chats:create', agentName, cwd),
      createVoice: (agentName) => call('chats:createVoice', agentName),
      createGroup: (members, cwd, role) => call('chats:createGroup', members, cwd, role),
      setRole: (chatId, role) => call('chats:setRole', chatId, role),
      setMembers: (chatId, members) => call('chats:setMembers', chatId, members),
      items: (chatId, before, until) => call('chats:items', chatId, before, until),
      pending: () => call('chats:pending'),
      search: (query, offset) => call('chats:search', query, offset),
      // Settles when the whole agent turn ends, so it is returned untouched (no timeout, no wrapping).
      send: (chatId, text, attachmentIds, replyTo, messageId, command, steer) =>
        steer
          ? call('chats:send', chatId, text, attachmentIds, replyTo, messageId, command, steer)
          : call('chats:send', chatId, text, attachmentIds, replyTo, messageId, command),
      sendTask: (chatId, taskId) => call('chats:sendTask', chatId, taskId),
      dropTask: (chatId, taskId) => call('chats:dropTask', chatId, taskId),
      edit: (chatId, itemId, text, command) => call('chats:edit', chatId, itemId, text, command),
      resend: (chatId, itemId) => call('chats:resend', chatId, itemId),
      switchVersion: (chatId, itemId, index) => call('chats:switchVersion', chatId, itemId, index),
      fork: (chatId, itemId) => call('chats:fork', chatId, itemId),
      summarizeRoom: (chatId) => call('chats:summarizeRoom', chatId),
      cancelSummary: (chatId) => call('chats:cancelSummary', chatId),
      cloneRoom: (chatId, title, handoff) => call('chats:cloneRoom', chatId, title, handoff),
      compact: (chatId, note, agent) => call('chats:compact', chatId, note, agent),
      setModel: (chatId, model) => call('chats:setModel', chatId, model),
      setPermissionMode: (chatId, mode) => call('chats:setPermissionMode', chatId, mode),
      allowBlocked: (chatId, toolUseId, prefixes, scope, folders = []) => call('chats:allowBlocked', chatId, toolUseId, prefixes, scope, folders),
      setEffort: (chatId, effort) => call('chats:setEffort', chatId, effort),
      cancelResume: (chatId) => call('chats:cancelResume', chatId),
      continueNow: (chatId) => call('chats:continueNow', chatId),
      stop: (chatId) => call('chats:stop', chatId),
      pause: (chatId) => call('chats:pause', chatId),
      resume: (chatId) => call('chats:resume', chatId),
      answer: (chatId, requestId, decision, agent) => call('chats:answer', chatId, requestId, decision, agent),
      answerQuestions: (chatId, requestId, answers, agent) => call('chats:answerQuestions', chatId, requestId, answers, agent),
      answerPlan: (chatId, requestId, approve, feedback, agent) => call('chats:answerPlan', chatId, requestId, approve, feedback, agent),
      rename: (chatId, title) => call('chats:rename', chatId, title),
      react: (chatId, itemId, emoji) => call('chats:react', chatId, itemId, emoji),
      markUnread: (chatId, itemId) => call('chats:markUnread', chatId, itemId),
      archive: (chatId, on) => call('chats:archive', chatId, on),
      remove: (chatId) => call('chats:remove', chatId),
      gitStatus: (chatId) => call('chats:gitStatus', chatId),
      gitChanges: (chatId, scope) => call('chats:gitChanges', chatId, scope ?? null),
      gitDiff: (chatId, path, scope) => call('chats:gitDiff', chatId, path, scope ?? null),
      onPush: (cb) => rpc.on('chats:push', (p: WirePush) => cb(p))
    },
    attachments: {
      stageBytes: (name, bytes) => uploadFile(o.fetch, name, bytes),
      discard: (id) => call('attachments:discard', id),
      // A file the server no longer has answers 404: false, so the UI shows "File missing". The desktop shell opens it natively, the browser in a tab.
      open: async (chatId, id, name) => {
        const url = attachmentUrl(chatId, id)
        try {
          if ((await o.fetch(url, { method: 'HEAD' })).status === 404) return false
        } catch {
          // offline: let the open attempt report it
        }
        if (o.desktop) return o.desktop.openAttachment(url, name)
        if (o.island) return o.island.openAttachment(url, name)
        o.openWindow(url)
        return true
      }
    },
    app: {
      pickFolder: async (agentName) => {
        const start = await call<FolderStart>('app:folderStart', agentName)
        return start.fixed ? start.path : o.folderPicker(start.path)
      },
      newChatFolder: async (agentName) => (await call<FolderStart>('app:folderStart', agentName)).path,
      lastFolder: (agentName) => call('app:lastFolder', agentName),
      lastGroupFolder: () => call('app:lastGroupFolder'),
      gitFolder: (cwd) => call('app:gitFolder', cwd),
      setWorktreeFolder: (cwd, on) => call('app:setWorktreeFolder', cwd, on),
      claudeStatus: () => call('app:claudeStatus'),
      setClaudePath: (path) => call('app:setClaudePath', path),
      getTheme: () => call('app:getTheme'),
      setTheme: (theme) => {
        o.desktop?.setTheme(theme)
        return call('app:setTheme', theme)
      },
      getAccent: () => call('app:getAccent'),
      setAccent: (accent) => call('app:setAccent', accent),
      getHouseStyle: () => call('app:getHouseStyle'),
      setHouseStyle: (on) => call('app:setHouseStyle', on),
      getSuggestedReplies: () => call('app:getSuggestedReplies'),
      setSuggestedReplies: (on) => call('app:setSuggestedReplies', on),
      onSuggestedRepliesChanged: (cb) => rpc.on('app:suggestedReplies', (p: { on: boolean }) => cb(p.on)),
      getKeepWarm: () => call('app:getKeepWarm'),
      setKeepWarm: (v) => call('app:setKeepWarm', v),
      setTimeZone: (tz) => call('app:setTimeZone', tz),
      account: () => call('app:account'),
      setEditorDirty: (dirty) => {
        if (o.desktop) return o.desktop.setEditorDirty(dirty)
        // The browser asks before the tab closes or reloads with unsaved edits.
        o.setBeforeUnload?.(dirty ? (e) => (e.preventDefault(), '') : null)
      },
      onSaveBeforeClose: (cb) => o.desktop?.onSaveBeforeClose(cb) ?? (() => {})
    },
    sidebar: {
      get: () => call('sidebar:get'),
      save: (layout) => call('sidebar:save', layout),
      onChanged: (cb) => rpc.on('sidebar:changed', (l: SidebarLayout) => cb(l))
    },
    memory: {
      list: (agent) => call('memory:list', agent),
      save: (agent, file, input, modified) => call('memory:save', agent, file, input, modified),
      remove: (agent, file, modified) => call('memory:remove', agent, file, modified),
      onChanged: (cb) => rpc.on('memory:changed', (p: { agent: string }) => cb(p.agent))
    },
    approvals: {
      list: (agentName) => call('approvals:list', agentName),
      remove: (agentName, key) => call('approvals:remove', agentName, key),
      addCli: (agentName, kind, value) => call('approvals:addCli', agentName, kind, value),
      onChanged: (cb) => rpc.on('approvals:changed', (p: { agent: string }) => cb(p.agent))
    },
    routines: {
      list: () => call('routines:list'),
      save: (input, meta) => call('routines:save', input, ...(meta ? [meta] : [])),
      remove: (id) => call('routines:remove', id),
      history: (id) => call('routines:history', id),
      version: (id, versionId) => call('routines:version', id, versionId),
      duplicate: (id) => call('routines:duplicate', id),
      setEnabled: (id, on) => call('routines:setEnabled', id, on),
      runNow: (id) => call('routines:runNow', id),
      draftWebhook: () => call('routines:draftWebhook'),
      dropDraft: (id) => call('routines:dropDraft', id),
      webhook: (id) => call('routines:webhook', id),
      newSecret: (id) => call('routines:newSecret', id),
      onChanged: (cb) => rpc.on('routines:changed', (s: RoutinesSnapshot) => cb(s))
    },
    workflows: {
      list: () => call('workflows:list'),
      getRun: (runId) => call('workflows:getRun', runId),
      save: (input, meta) => call('workflows:save', input, ...(meta ? [meta] : [])),
      remove: (id) => call('workflows:remove', id),
      history: (id) => call('workflows:history', id),
      version: (id, versionId) => call('workflows:version', id, versionId),
      duplicate: (id) => call('workflows:duplicate', id),
      setEnabled: (id, on) => call('workflows:setEnabled', id, on),
      run: (id, input) => call('workflows:run', id, input),
      stop: (runId) => call('workflows:stop', runId),
      continueCap: (runId) => call('workflows:continueCap', runId),
      retry: (runId, visitId, itemId) => call('workflows:retry', runId, visitId, ...(itemId === undefined ? [] : [itemId])),
      approve: (runId, visitId, ok, text, note) => call('workflows:approve', runId, visitId, ok, text, note),
      testStep: (draft, stepId, input) => call('workflows:testStep', draft, stepId, input),
      draftWebhook: () => call('workflows:draftWebhook'),
      dropDraft: (id) => call('workflows:dropDraft', id),
      webhook: (id) => call('workflows:webhook', id),
      newSecret: (id) => call('workflows:newSecret', id),
      approvals: () => call('workflows:approvals'),
      checkMail: (trigger) => call('workflows:checkMail', trigger),
      runFromChat: (chatId, text, workflowId) => call('workflows:runFromChat', chatId, text, workflowId ?? null),
      onChanged: (cb) => rpc.on('workflows:changed', (s: WorkflowsSnapshot) => cb(s))
    },
    inbox: {
      messages: () => call('inbox:messages'),
      archive: (id, on) => call('inbox:archive', id, on),
      remove: (id) => call('inbox:remove', id),
      restore: (id) => call('inbox:restore', id),
      seen: (at) => call('inbox:seen', at),
      onChanged: (cb) => rpc.on('inbox:changed', () => cb())
    },
    jev: {
      status: () => call('jev:status'),
      setKey: (key) => call('jev:setKey', key),
      setSwitches: (patch) => call('jev:setSwitches', patch),
      check: () => call('jev:check'),
      suggestAgent: (text) => call('jev:suggestAgent', text)
    },
    voice: {
      status: () => call('voice:status'),
      set: (patch) => call('voice:set', patch),
      check: () => call('voice:check'),
      onChanged: (cb) => rpc.on('voice:changed', (s: VoiceStatus) => cb(s))
    },
    channels: {
      status: () => call('channels:status'),
      setToken: (platform, token, appToken) => call('channels:setToken', platform, token, appToken),
      setSharedCards: (platform, on) => call('channels:setSharedCards', platform, on),
      setNotify: (platform, toggles) => call('channels:setNotify', platform, toggles),
      removeToken: (platform) => call('channels:removeToken', platform),
      setRun: (platform, on) => call('channels:setRun', platform, on),
      pairStart: (platform) => call('channels:pairStart', platform),
      pairCancel: (platform) => call('channels:pairCancel', platform),
      unpair: (platform) => call('channels:unpair', platform),
      setAgents: (platform, names) => call('channels:setAgents', platform, names),
      link: (chatId, platform) => call('channels:link', chatId, platform),
      unlink: (chatId) => call('channels:unlink', chatId),
      onChanged: (cb) => rpc.on('channels:changed', () => cb())
    },
    vault: {
      status: () => call('vault:status'),
      keyFile: () => call('vault:keyFile'),
      list: () => call('vault:list'),
      reveal: (id, field) => call('vault:reveal', id, field),
      save: (input, updatedAt) => call('vault:save', input, updatedAt),
      delete: (id) => call('vault:delete', id),
      removeApproval: (id, site, frameSite) => call('vault:removeApproval', id, site, frameSite),
      reset: () => call('vault:reset'),
      answer: (chatId, requestId, decision) => call('vault:answer', chatId, requestId, decision),
      onChanged: (cb) => rpc.on('vault:changed', () => cb())
    },
    update: {
      status: () => call('update:status'),
      check: () => call('update:check'),
      install: (opts) => call('update:install', opts),
      rollBack: (opts) => call('update:rollBack', opts),
      onChanged: (cb) => rpc.on('update:changed', (s: UpdateStatus) => cb(s))
    },
    audit: {
      list: (filter, cursor, limit) => call('audit:list', filter, cursor, limit ?? null),
      get: (id, at) => call('audit:get', id, at),
      facets: () => call('audit:facets'),
      status: () => call('audit:status'),
      verify: () => call('audit:verify'),
      setCap: (bytes) => call('audit:setCap', bytes),
      onChanged: (cb) => rpc.on('audit:changed', () => cb())
    },
    isolation: {
      status: (fresh) => call('isolation:status', fresh ?? false),
      get: (agent) => call('isolation:get', agent),
      set: (agent, isolation) => call('isolation:set', agent, isolation)
    },
    // JSON has no undefined, so an optional argument goes as null.
    extensions: {
      loadout: (folder, agent, refresh) => call('extensions:loadout', folder, agent, refresh ?? false),
      server: (folder, scope, name) => call('extensions:server', folder, scope, name),
      saveServer: (folder, scope, name, input, prevName, stamp) =>
        call('extensions:saveServer', folder, scope, name, input, prevName ?? null, stamp ?? null),
      removeServer: (folder, scope, name) => call('extensions:removeServer', folder, scope, name),
      setPlugin: (id, enabled) => call('extensions:setPlugin', id, enabled),
      skill: (scope, folder, name) => call('extensions:skill', scope, folder, name),
      saveSkill: (scope, folder, input) => call('extensions:saveSkill', scope, folder, input),
      removeSkill: (scope, folder, name) => call('extensions:removeSkill', scope, folder, name),
      setSkill: (name, on) => call('extensions:setSkill', name, on),
      saveHook: (file, folder, input, stamp) => call('extensions:saveHook', file, folder, input, stamp),
      removeHook: (file, folder, event, at, stamp) => call('extensions:removeHook', file, folder, event, at, stamp),
      onChanged: (cb) => rpc.on('extensions:changed', () => cb())
    },
    connectors: {
      list: (refresh) => call('connectors:list', refresh ?? false),
      setAgent: (id, agent, on) => call('connectors:setAgent', id, agent, on),
      setRemember: (id, on) => call('connectors:setRemember', id, on),
      onChanged: (cb) => rpc.on('connectors:changed', () => cb())
    },
    files: {
      list: (chatId) => call('files:list', chatId),
      restore: (chatId, path, fromId, toId) => call('files:restore', chatId, path, fromId, toId)
    },
    todos: {
      board: () => call('todos:board'),
      list: (chatId) => call('todos:list', chatId),
      add: (text, chatId) => call('todos:add', text, chatId),
      check: (ids, done) => call('todos:check', ids, done),
      remove: (ids) => call('todos:remove', ids),
      restore: (ids) => call('todos:restore', ids),
      edit: (id, patch) => call('todos:edit', id, patch),
      assign: (id, assignee, folder) => call('todos:assign', id, assignee, folder),
      answer: (id, answers) => call('todos:answer', id, answers),
      reply: (id, text) => call('todos:reply', id, text),
      move: (id, status) => call('todos:move', id, status),
      comment: (id, text, replyTo) => call('todos:comment', id, text, replyTo ?? null),
      editComment: (id, commentId, text) => call('todos:editComment', id, commentId, text),
      deleteComment: (id, commentId) => call('todos:deleteComment', id, commentId),
      onChanged: (cb) => rpc.on('todos:changed', (p: { rev: number }) => cb(p.rev))
    },
    github: {
      state: () => call('github:state'),
      draftPr: (chatId) => call('github:draftPr', chatId),
      createPr: (chatId, input) => call('github:createPr', chatId, input),
      refreshPr: (chatId) => call('github:refreshPr', chatId),
      sendCheck: (chatId, name) => call('github:sendCheck', chatId, name)
    },
    attempts: {
      start: (todoId, picks, folder) => call('attempts:start', todoId, picks, folder ?? null),
      keep: (todoId, chatId) => call('attempts:keep', todoId, chatId),
      cancel: (todoId) => call('attempts:cancel', todoId)
    },
    dispatch: {
      list: (chatId) => call('dispatch:list', chatId),
      get: (chatId, id, from) => call('dispatch:get', chatId, id, from ?? null),
      onChanged: (cb) => rpc.on('dispatch:changed', (p: { chatId: string }) => cb(p.chatId))
    },
    processes: {
      list: (chatId) => call('processes:list', chatId),
      logs: (chatId, id, from) => call('processes:logs', chatId, id, from ?? null),
      stop: (chatId, id) => call('processes:stop', chatId, id),
      restart: (chatId, id) => call('processes:restart', chatId, id),
      forget: (chatId, id) => call('processes:forget', chatId, id),
      run: (chatId, messageId, command) => call('processes:run', chatId, messageId, command),
      counts: () => call('processes:counts'),
      onChanged: (cb) => rpc.on('processes:changed', (p: { chatId: string; running: number }) => cb(p)),
      onOutput: (cb) => rpc.on('processes:output', (p: { chatId: string; id: string; to: number }) => cb(p))
    },
    usage: {
      query: (q) => call('usage:query', q),
      caps: () => call('usage:caps'),
      allowMore: (agent) => call('usage:allowMore', agent),
      onChanged: (cb) => rpc.on('usage:changed', (p: { chatId: string | null }) => cb(p.chatId))
    },
    notify: {
      status: (deviceId) => call('notify:status', deviceId),
      enable: (deviceId, o) => call('notify:enable', deviceId, o),
      refresh: (deviceId, subscription) => call('notify:refresh', deviceId, subscription),
      disable: (deviceId) => call('notify:disable', deviceId),
      remove: (deviceId) => call('notify:remove', deviceId),
      setPrefs: (deviceId, t) => call('notify:setPrefs', deviceId, t),
      test: (deviceId) => call('notify:test', deviceId),
      presence: (deviceId, chatId, looking, inputAgoMs, openedAgoMs) =>
        call('notify:presence', deviceId, chatId, looking, inputAgoMs, openedAgoMs),
      state: () => call('notify:state'),
      onShow: (cb) => rpc.on('notify:show', (p: NotifyPayload) => cb(p)),
      onClear: (cb) => rpc.on('notify:clear', (p: NotifyClear) => cb(p))
    },
    session: {
      mode: () => call('app:mode'),
      signOut: () => logout('/api/logout'),
      signOutEverywhere: () => logout('/api/logout-all')
    },
    connection: {
      onStatus: (cb) => {
        const off = rpc.onStatus(cb)
        cb(rpc.status()) // a late subscriber learns the current state
        return off
      }
    },
    desktop: o.desktop
  }
}
