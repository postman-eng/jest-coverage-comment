import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { ChangedFiles, Options } from './types.d'

/** Generate object of all files that changed based on commit through GitHub API. */
export async function getChangedFiles(
  options: Options
): Promise<ChangedFiles | null> {
  const all: string[] = []
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  const renamed: string[] = []
  const addedOrModified: string[] = []
  const changedLines: Record<string, number[]> = {}

  try {
    const { eventName, payload } = context
    const { repo, owner } = context.repo
    const octokit = getOctokit(options.token)

    // Define the base and head commits to be extracted from the payload
    let base
    let head

    switch (eventName) {
      case 'pull_request':
        base = payload.pull_request?.base.sha
        head = payload.pull_request?.head.sha
        break
      case 'push':
        base = payload.before
        head = payload.after
        break
      default:
        core.warning(
          `"report-only-changed-files: true" supported only on 'pull_request' and 'push', '${eventName}' events are not supported.`
        )
        return null
    }

    core.startGroup('Changed files')
    // Log the base and head commits
    core.info(`Base commit: ${base}`)
    core.info(`Head commit: ${head}`)

    // Resolve the set of changed files (with per-file patch) for this event.
    //
    // pull_request / push-on-a-PR-branch: use the PR's own file list. octokit.paginate
    //   walks every page, so there is no 300-file cap, and it returns the same
    //   three-dot diff GitHub shows under "Files changed". (The compare endpoint only
    //   paginates its `commits` array, not `files`, so paginating it never returned
    //   >300 files and could duplicate the truncated list across pages.)
    // push without a PR: diff the pushed range before...after via the compare endpoint.
    //   Compare caps `files` at 300, but such push diffs are typically small.
    // new branch / first commit (all-zero base): no range to diff, fall back to the
    //   tip commit.
    const EMPTY_SHA = '0000000000000000000000000000000000000000'
    // Resolved once in main() and shared with the comment-posting code so the
    // open-PR lookup for push events happens a single time per run.
    const prNumber = options.prNumber ?? (await getPrNumber(options))

    let files: { filename: string; status?: string; patch?: string }[] = []

    if (prNumber) {
      files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })
    } else if (base === EMPTY_SHA) {
      files =
        (await octokit.rest.repos.getCommit({ owner, repo, ref: head })).data
          .files ?? []
    } else {
      files =
        (await octokit.rest.repos.compareCommits({ base, head, owner, repo }))
          .data.files ?? []
    }

    if (files?.length) {
      for (const file of files) {
        const { filename: filenameOriginal, status } = file
        const filename = filenameOriginal.replace(
          options.coveragePathPrefix || '',
          ''
        )

        all.push(filename)

        // Capture the head-side line numbers touched by this file's patch so we can
        // compute patch (incremental) coverage against only the changed lines.
        if (file.patch) {
          changedLines[filename] = parsePatchAddedLines(file.patch)
        }

        switch (status) {
          case 'added':
            added.push(filename)
            addedOrModified.push(filename)
            break
          case 'modified':
            modified.push(filename)
            addedOrModified.push(filename)
            break
          case 'removed':
            removed.push(filename)
            break
          case 'renamed':
            renamed.push(filename)
            break
          default:
            core.setFailed(
              `One of your files includes an unsupported file status '${status}', expected added, modified, removed, renamed`
            )
        }
      }
    }

    core.info(`All: ${all.join(',')}`)
    core.info(`Added: ${added.join(', ')}`)
    core.info(`Modified: ${modified.join(', ')}`)
    core.info(`Removed: ${removed.join(', ')}`)
    core.info(`Renamed: ${renamed.join(', ')}`)
    core.info(`Added or modified: ${addedOrModified.join(', ')}`)

    core.endGroup()
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }

  return {
    all,
    added,
    modified,
    removed,
    renamed,
    addedOrModified,
    changedLines,
  }
}

/**
 * Resolve the PR number for the current run. On pull_request events it comes
 * straight from the payload. A push event carries no PR association, so we look
 * up the OPEN PR whose head is the pushed branch. Branch is the reliable key: a
 * commit can belong to multiple PRs, so commit-attached PR info is ambiguous.
 * Returns undefined for a push with no associated open PR.
 */
export async function getPrNumber(
  options: Options
): Promise<number | undefined> {
  const { eventName, payload } = context
  const { repo, owner } = context.repo

  if (payload.pull_request?.number) {
    return payload.pull_request.number
  }

  if (eventName === 'push') {
    const branch = (context.ref || '').replace(/^refs\/heads\//, '')
    if (branch) {
      const octokit = getOctokit(options.token)
      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${branch}`,
        per_page: 1,
      })
      if (prs.length) {
        return prs[0].number
      }
    }
  }

  return undefined
}

/**
 * Parse a unified-diff patch string and return the head-side (new file) line
 * numbers that were added or modified. Only `+` lines are considered "changed".
 */
export function parsePatchAddedLines(patch: string): number[] {
  const lines: number[] = []
  // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
  let newLineNo = 0

  for (const raw of patch.split('\n')) {
    const header = raw.match(hunkHeader)
    if (header) {
      newLineNo = parseInt(header[1], 10)
      continue
    }

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" marker - metadata, never a real line.
      continue
    }

    if (raw.startsWith('+')) {
      // Added/modified line present in the head revision.
      lines.push(newLineNo)
      newLineNo++
    } else if (raw.startsWith('-')) {
      // Deleted line - does not exist on the head side, do not advance.
    } else {
      // Context line - advances the head cursor.
      newLineNo++
    }
  }

  return lines
}
