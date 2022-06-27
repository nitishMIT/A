import { Installation } from "models/installation";
import { NextFunction, Request, Response } from "express";
import { sendError, TokenType, verifySymmetricJwtTokenMiddleware } from "../jira/util/jwt";

export const verifyJiraJwtMiddleware = (tokenType: TokenType) => async (
	req: Request,
	res: Response,
	next: NextFunction
): Promise<void> => {
	const { jiraHost } = res.locals;

	if (!jiraHost) {
		sendError(res, 401, "Unauthorised");
		return;
	}

	const installation = await Installation.getForHost(jiraHost);

	if (!installation) {
		return next(new Error("Not Found"));
	}
	// TODO: Probably not the best place to set things globally
	res.locals.installation = installation;

	req.log = req.log.child({
		jiraHost: installation.jiraHost,
		jiraClientKey:
			installation.clientKey && `${installation.clientKey.substr(0, 5)}***`
	});

	verifySymmetricJwtTokenMiddleware(
		installation.sharedSecret,
		tokenType,
		req,
		res,
		next);
};

export const JiraJwtTokenMiddleware = verifyJiraJwtMiddleware(TokenType.normal);
export const JiraContextJwtTokenMiddleware = verifyJiraJwtMiddleware(TokenType.context);

export const authenticateJiraEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	verifySymmetricJwtTokenMiddleware(res.locals.installation.sharedSecret, TokenType.normal, req, res, next);
};
