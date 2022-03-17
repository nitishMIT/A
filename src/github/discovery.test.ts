/* eslint-disable jest/expect-expect */
import { Installation, RepoSyncState, Subscription } from "../models";
import { sqsQueues } from "../sqs/queues";
import { createWebhookApp } from "test/utils/probot";
import app from "../worker/app";
import { discovery, discoveryOctoKit } from "../sync/discovery";
import { getLogger } from "../config/logger";
import waitUntil from "test/utils/waitUntil";
import { when } from "jest-when";
import { booleanFlag, BooleanFlags } from "../config/feature-flags";

import listRepositories from "fixtures/list-repositories.json";

jest.mock("../config/feature-flags");

describe("Discovery Queue Test - Ocktokit", () => {
	const TEST_INSTALLATION_ID = 1234;
	let sendMessageSpy: jest.SpyInstance;

	beforeEach(async () => {
		await createWebhookApp();
		const clientKey = "client-key";
		await Installation.create({
			clientKey,
			sharedSecret: "shared-secret",
			jiraHost
		});

		await Subscription.create({
			jiraHost,
			gitHubInstallationId: TEST_INSTALLATION_ID,
			jiraClientKey: clientKey
		});

		await sqsQueues.discovery.start();

		sendMessageSpy = jest.spyOn(sqsQueues.backfill, "sendMessage");
	});

	afterEach(async () => {
		await sqsQueues.discovery.stop();
		await sqsQueues.discovery.purgeQueue();
	});

	const mockGitHubReposResponses = () => {
		githubUserTokenNock(TEST_INSTALLATION_ID);
		githubNock.get("/installation/repositories?per_page=100")
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			.reply(200, listRepositories);
	};

	async function verify2RepositoriesInTheStateAndBackfillMessageSent() {
		expect(sendMessageSpy).toBeCalledTimes(1);
		const subscription = await Subscription.getSingleInstallation(jiraHost, TEST_INSTALLATION_ID);
		expect(subscription).toBeTruthy();
		const states = await RepoSyncState.findAllFromSubscription(subscription!);
		expect(states.length).toBe(2);
	}

	it("Discovery sqs queue processes the message", async () => {
		mockGitHubReposResponses();
		await sqsQueues.discovery.sendMessage({ installationId: TEST_INSTALLATION_ID, jiraHost });
		await waitUntil(async () => {
			await verify2RepositoriesInTheStateAndBackfillMessageSent();
		});
	});

	it("Discovery queue listener works correctly", async () => {
		mockGitHubReposResponses();
		await discoveryOctoKit(app)({ data: { installationId: TEST_INSTALLATION_ID, jiraHost } }, getLogger("test"));
		await verify2RepositoriesInTheStateAndBackfillMessageSent();
	});
});

describe("Discovery Queue Test - GitHub Client", () => {
	const TEST_INSTALLATION_ID = 1234;
	let sendMessageSpy: jest.SpyInstance;

	beforeEach(async () => {
		await createWebhookApp();
		const clientKey = "client-key";
		await Installation.create({
			clientKey,
			sharedSecret: "shared-secret",
			jiraHost
		});

		await Subscription.create({
			jiraHost,
			gitHubInstallationId: TEST_INSTALLATION_ID,
			jiraClientKey: clientKey
		});

		when(booleanFlag).calledWith(
			BooleanFlags.USE_NEW_GITHUB_CLIENT_FOR_DISCOVERY,
			expect.anything(),
			expect.anything()
		).mockResolvedValue(true);

		await sqsQueues.discovery.start();

		sendMessageSpy = jest.spyOn(sqsQueues.backfill, "sendMessage");
	});

	afterEach(async () => {
		await sqsQueues.discovery.stop();
		await sqsQueues.discovery.purgeQueue();
	});

	const mockGitHubReposResponses = () => {
		githubUserTokenNock(TEST_INSTALLATION_ID);
		const linkLastPage = "<https://api.github.com/installation/repositories?per_page=1&page=2>; rel=\"prev\", <https://api.github.com/installation/repositories?per_page=1&page=2>; rel=\"first\"";
		githubNock
			.get("/installation/repositories?per_page=100&page=1")
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			.reply(200, listRepositories, { "link": linkLastPage });
	};

	it("Discovery sqs queue processes the message", async () => {
		mockGitHubReposResponses();
		await sqsQueues.discovery.sendMessage({ installationId: TEST_INSTALLATION_ID, jiraHost });
		await waitUntil(async () => {
			expect(sendMessageSpy).toBeCalledTimes(1);
			const subscription = await Subscription.getSingleInstallation(jiraHost, TEST_INSTALLATION_ID);
			expect(subscription).toBeTruthy();
			const states = await RepoSyncState.findAllFromSubscription(subscription!);
			expect(states.length).toBe(2);
		});
	});

	it("Discovery queue listener works correctly", async () => {
		mockGitHubReposResponses();
		await discovery({ installationId: TEST_INSTALLATION_ID, jiraHost }, getLogger("test"));
		expect(sendMessageSpy).toBeCalledTimes(1);
		const subscription = await Subscription.getSingleInstallation(jiraHost, TEST_INSTALLATION_ID);
		expect(subscription).toBeTruthy();
		const states = await RepoSyncState.findAllFromSubscription(subscription!);
		expect(states.length).toBe(2);
	});

});