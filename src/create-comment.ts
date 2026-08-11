import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { Options } from './types.d'

const MAX_COMMENT_LENGTH = 65536

export async function createComment(
  options: Options,
  body: string
): Promise<void> {
  try {
    const { eventName, payload } = context
    const { repo, owner } = context.repo

    const octokit = getOctokit(options.token)
    const issue_number = payload.pull_request ? payload.pull_request.number : 0

    if (body.length > MAX_COMMENT_LENGTH) {
      const warningsArr = [
        `Your comment is too long (maximum is ${MAX_COMMENT_LENGTH} characters), coverage report will not be added.`,
        'Try one/some of the following:',
        `- Add "['text-summary', { skipFull: true }]" - to remove fully covered files from report`,
        '- Add "hide-summary: true" - to remove the summary report',
      ]

      if (!options.reportOnlyChangedFiles) {
        warningsArr.push(
          '- Add "report-only-changed-files: true" - to report only changed files and not all files'
        )
      }

      if (!options.removeLinksToFiles) {
        warningsArr.push(
          '- Add "remove-links-to-files: true" - to remove links to files'
        )
      }

      if (!options.removeLinksToLines) {
        warningsArr.push(
          '- Add "remove-links-to-lines: true" - to remove links to lines'
        )
      }

      core.warning(warningsArr.join('\n'))
    }

    const isPullRequestEvent =
      eventName === 'pull_request' || eventName === 'pull_request_target'

    // A push on a PR branch resolves to that PR (options.prNumber). Prefer a
    // PR-level (issue) comment there too, so push-triggered workflows get a
    // single comment updated in place rather than a per-commit comment.
    const prNumber = issue_number || options.prNumber

    if (prNumber && (isPullRequestEvent || eventName === 'push')) {
      await upsertIssueComment(octokit, options, prNumber, body)
    } else if (eventName === 'push') {
      core.info('No open PR for branch, creating commit comment')

      await octokit.rest.repos.createCommitComment({
        repo,
        owner,
        commit_sha: options.commit,
        body,
      })
    } else if (!isPullRequestEvent && !options.hideComment) {
      core.warning(
        `This action supports comments only on 'pull_request', 'pull_request_target' and 'push' events. '${eventName}' events are not supported.\nYou can use the output of the action.`
      )
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(error.message)
    }
  }
}

/**
 * Post or update a single PR-level (issue) comment. Existing comments are matched
 * by watermark, which encodes the job name and unique id, so distinct coverage
 * types (e.g. unit vs integration) each maintain their own comment in place.
 */
async function upsertIssueComment(
  octokit: ReturnType<typeof getOctokit>,
  options: Options,
  issue_number: number,
  body: string
): Promise<void> {
  const { repo, owner } = context.repo

  if (options.createNewComment) {
    core.info('Creating a new comment')

    await octokit.rest.issues.createComment({
      repo,
      owner,
      issue_number,
      body,
    })
    return
  }

  const { data: comments } = await octokit.rest.issues.listComments({
    repo,
    owner,
    issue_number,
  })

  const comment = comments.find(
    (c) =>
      c.user?.login === 'github-actions[bot]' &&
      c.body?.startsWith(options.watermark)
  )

  if (comment) {
    core.info('Found previous comment, updating')
    await octokit.rest.issues.updateComment({
      repo,
      owner,
      comment_id: comment.id,
      body,
    })
  } else {
    core.info('No previous comment found, creating a new one')
    await octokit.rest.issues.createComment({
      repo,
      owner,
      issue_number,
      body,
    })
  }
}
