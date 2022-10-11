/* eslint-disable @typescript-eslint/no-var-requires,@typescript-eslint/no-explicit-any */
import { branchesNoLastCursor } from "fixtures/api/graphql/branch-queries";
import { mocked } from "ts-jest/utils";
import { processInstallation } from "./installation";
import { getLogger } from "config/logger";
import { cleanAll } from "nock";
import { Hub } from "@sentry/types/dist/hub";
import { BackfillMessagePayload } from "../sqs/sqs.types";
import { sqsQueues } from "../sqs/queues";

import branchNodesFixture from "fixtures/api/graphql/branch-ref-nodes.json";

import branchCommitsHaveKeys from "fixtures/api/graphql/branch-commits-have-keys.json";

import associatedPRhasKeys from "fixtures/api/graphql/branch-associated-pr-has-keys.json";

import branchNoIssueKeys from "fixtures/api/graphql/branch-no-issue-keys.json";
import { jiraIssueKeyParser } from "utils/jira-utils";
import { when } from "jest-when";
import { booleanFlag, BooleanFlags, numberFlag, NumberFlags } from "config/feature-flags";
import { waitUntil } from "test/utils/wait-until";
import { GitHubServerApp } from "models/github-server-app";
import { transformRepositoryId } from "~/src/transforms/transform-repository-id";
import { DatabaseStateBuilder } from "test/utils/database-state-builder";

jest.mock("../sqs/queues");
jest.mock("config/feature-flags");

describe("sync/branches", () => {

	const sentry: Hub = { setUser: jest.fn() } as any;

	beforeEach(() => {
		mockSystemTime(12345678);
	});

	const makeExpectedResponseCloudServer = (branchName: string, repoId: string) => ({
		preventTransitions: true,
		repositories: [
			{
				branches: [
					{
						createPullRequestUrl: `test-repo-url/compare/${branchName}?title=TES-123-${branchName}&quick_pull=1`,
						id: branchName,
						issueKeys: ["TES-123"]
							.concat(jiraIssueKeyParser(branchName))
							.reverse()
							.filter((key) => !!key),
						lastCommit: {
							author: {
								avatar: "https://camo.githubusercontent.com/test-avatar",
								email: "test-author-email@example.com",
								name: "test-author-name"
							},
							authorTimestamp: "test-authored-date",
							displayId: "test-o",
							fileCount: 0,
							hash: "test-oid",
							id: "test-oid",
							issueKeys: ["TES-123"],
							message: "TES-123 test-commit-message",
							url: "test-repo-url/commit/test-sha",
							updateSequenceId: 12345678
						},
						name: branchName,
						url: `test-repo-url/tree/${branchName}`,
						updateSequenceId: 12345678
					}
				],
				commits: [
					{
						author: {
							avatar: "https://camo.githubusercontent.com/test-avatar",
							email: "test-author-email@example.com",
							name: "test-author-name"
						},
						authorTimestamp: "test-authored-date",
						displayId: "test-o",
						fileCount: 0,
						hash: "test-oid",
						id: "test-oid",
						issueKeys: ["TES-123"],
						message: "TES-123 test-commit-message",
						timestamp: "test-authored-date",
						url: "test-repo-url/commit/test-sha",
						updateSequenceId: 12345678
					}
				],
				id: repoId,
				name: "test-repo-name",
				url: "test-repo-url",
				updateSequenceId: 12345678
			}
		],
		properties: {
			installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID
		}
	});

	describe("cloud", () => {

		const makeExpectedResponse = (branchName: string) => {
			return makeExpectedResponseCloudServer(branchName, "1");
		};

		const nockGitHubGraphQlRateLimit = (rateLimitReset: string) => {
			githubNock
				.post("/graphql", branchesNoLastCursor())
				.query(true)
				.reply(200, {
					"errors": [
						{
							"type": "RATE_LIMITED",
							"message": "API rate limit exceeded for user ID 42425541."
						}
					]
				}, {
					"X-RateLimit-Reset": rateLimitReset,
					"X-RateLimit-Remaining": "10"
				});
		};

		const nockBranchRequest = (response, variables?: Record<string, any>) =>
			githubNock
				.post("/graphql", branchesNoLastCursor(variables))
				.query(true)
				.reply(200, response);

		const mockBackfillQueueSendMessage = mocked(sqsQueues.backfill.sendMessage);

		beforeEach(async () => {

			await new DatabaseStateBuilder()
				.withActiveRepoSyncState()
				.repoSyncStatePendingForBranches()
				.build();

			mocked(sqsQueues.backfill.sendMessage).mockResolvedValue(Promise.resolve());
			githubUserTokenNock(DatabaseStateBuilder.GITHUB_INSTALLATION_ID);

		});

		const verifyMessageSent = async (data: BackfillMessagePayload, delaySec?: number) => {
			await waitUntil(async () => {
				expect(githubNock).toBeDone();
				expect(jiraNock).toBeDone();
			});
			expect(mockBackfillQueueSendMessage.mock.calls).toHaveLength(1);
			expect(mockBackfillQueueSendMessage.mock.calls[0][0]).toEqual(data);
			expect(mockBackfillQueueSendMessage.mock.calls[0][1]).toEqual(delaySec || 0);
		};

		it("should sync to Jira when branch refs have jira references", async () => {
			const data: BackfillMessagePayload = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
			nockBranchRequest(branchNodesFixture);

			jiraNock
				.post(
					"/rest/devinfo/0.10/bulk",
					makeExpectedResponse("branch-with-issue-key-in-the-last-commit")
				)
				.reply(200);

			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
			await verifyMessageSent(data);
		});

		it("should send data if issue keys are only present in commits", async () => {
			const data = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
			nockBranchRequest(branchCommitsHaveKeys);

			jiraNock
				.post(
					"/rest/devinfo/0.10/bulk",
					makeExpectedResponse("dev")
				)
				.reply(200);

			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
			await verifyMessageSent(data);
		});

		it("should send data if issue keys are only present in an associated PR title", async () => {
			const data = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
			nockBranchRequest(associatedPRhasKeys);

			jiraNock
				.post("/rest/devinfo/0.10/bulk", {
					preventTransitions: true,
					repositories: [
						{
							branches: [
								{
									createPullRequestUrl: "test-repo-url/compare/dev?title=PULL-123-dev&quick_pull=1",
									id: "dev",
									issueKeys: ["PULL-123"],
									lastCommit: {
										author: {
											avatar: "https://camo.githubusercontent.com/test-avatar",
											email: "test-author-email@example.com",
											name: "test-author-name"
										},
										authorTimestamp: "test-authored-date",
										displayId: "test-o",
										fileCount: 0,
										hash: "test-oid",
										issueKeys: [],
										id: "test-oid",
										message: "test-commit-message",
										url: "test-repo-url/commit/test-sha",
										updateSequenceId: 12345678
									},
									name: "dev",
									url: "test-repo-url/tree/dev",
									updateSequenceId: 12345678
								}
							],
							commits: [],
							id: "1",
							name: "test-repo-name",
							url: "test-repo-url",
							updateSequenceId: 12345678
						}
					],
					properties: {
						installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID
					}
				})
				.reply(200);

			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
			await verifyMessageSent(data);
		});

		it("should not call Jira if no issue keys are found", async () => {
			const data = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
			nockBranchRequest(branchNoIssueKeys);

			jiraNock.post(/.*/).reply(200);

			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
			expect(jiraNock).not.toBeDone();
			cleanAll();
			await verifyMessageSent(data);
		});

		it("should reschedule message with delay if there is rate limit", async () => {
			const data = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
			nockGitHubGraphQlRateLimit("12360");
			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
			await verifyMessageSent(data, 15);
		});

		describe("SYNC_BRANCH_COMMIT_TIME_LIMIT FF is enabled", () => {
			let dateCutoff: Date;
			beforeEach(() => {
				const time = Date.now();
				const cutoff = 1000 * 60 * 60 * 24;
				mockSystemTime(time);
				dateCutoff = new Date(time - cutoff);

				when(numberFlag).calledWith(
					NumberFlags.SYNC_BRANCH_COMMIT_TIME_LIMIT,
					expect.anything(),
					expect.anything()
				).mockResolvedValue(cutoff);
			});

			it("should sync to Jira when branch refs have jira references", async () => {
				const data: BackfillMessagePayload = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost };
				nockBranchRequest(branchNodesFixture, { commitSince: dateCutoff.toISOString() });

				jiraNock
					.post(
						"/rest/devinfo/0.10/bulk",
						makeExpectedResponse("branch-with-issue-key-in-the-last-commit")
					)
					.reply(200);

				await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
				await verifyMessageSent(data);
			});

			describe("Branch commit history value is passed", () => {

				it("should use commit history depth parameter before feature flag time", async () => {
					const time = Date.now();
					const commitTimeLimitCutoff = 1000 * 60 * 60 * 96;
					mockSystemTime(time);
					const commitsFromDate = new Date(time - commitTimeLimitCutoff).toISOString();
					const data: BackfillMessagePayload = { installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID, jiraHost, commitsFromDate };

					nockBranchRequest(branchNodesFixture, { commitSince: commitsFromDate });
					jiraNock
						.post(
							"/rest/devinfo/0.10/bulk",
							makeExpectedResponse("branch-with-issue-key-in-the-last-commit")
						)
						.reply(200);

					await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
					await verifyMessageSent(data);
				});
			});
		});
	});

	describe("server", () => {
		let gitHubServerApp: GitHubServerApp;

		const nockBranchRequest = (response, variables?: Record<string, any>) =>
			gheNock
				.post("/api/graphql", branchesNoLastCursor(variables))
				.query(true)
				.reply(200, response);

		beforeEach(async () => {
			when(jest.mocked(booleanFlag))
				.calledWith(BooleanFlags.GHE_SERVER, expect.anything(), expect.anything())
				.mockResolvedValue(true);

			const builderResult = await new DatabaseStateBuilder()
				.forServer()
				.withActiveRepoSyncState()
				.repoSyncStatePendingForBranches()
				.build();
			gitHubServerApp = builderResult.gitHubServerApp!;

			gheUserTokenNock(DatabaseStateBuilder.GITHUB_INSTALLATION_ID);
		});

		const makeExpectedResponse = async (branchName: string) => {
			return makeExpectedResponseCloudServer(branchName, await transformRepositoryId(1, gheUrl));
		};

		it("should sync to Jira when branch refs have jira references", async () => {
			const data: BackfillMessagePayload = {
				installationId: DatabaseStateBuilder.GITHUB_INSTALLATION_ID,
				jiraHost,
				gitHubAppConfig: {
					uuid: gitHubServerApp.uuid,
					gitHubAppId: gitHubServerApp.id,
					appId: gitHubServerApp.appId,
					clientId: gitHubServerApp.gitHubClientId,
					gitHubBaseUrl: gitHubServerApp.gitHubBaseUrl,
					gitHubApiUrl: gitHubServerApp.gitHubBaseUrl + "/v3/api"
				}
			};

			nockBranchRequest(branchNodesFixture);

			jiraNock
				.post(
					"/rest/devinfo/0.10/bulk",
					await makeExpectedResponse("branch-with-issue-key-in-the-last-commit")
				)
				.reply(200);

			await expect(processInstallation()(data, sentry, getLogger("test"))).toResolve();
		});
	});
});
