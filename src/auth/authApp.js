/* @flow */
import { decodeToken } from 'jsontokens'
import protocolCheck from 'custom-protocol-detection-blockstack'
import { verifyAuthResponse } from './index'
import { BLOCKSTACK_HANDLER, isLaterVersion, hexStringToECPair } from '../utils'
import { getAddressFromDID } from '../index'
import { InvalidStateError, LoginFailedError } from '../errors'
import { decryptPrivateKey } from './authMessages'
import {
  BLOCKSTACK_DEFAULT_GAIA_HUB_URL,
  DEFAULT_BLOCKSTACK_HOST,
  NAME_LOOKUP_PATH,
  DEFAULT_CORE_NODE
} from './authConstants'

import { extractProfile } from '../profiles'

import { Logger } from '../logger'

import type { UserSession } from './userSession'

const DEFAULT_PROFILE = {
  '@type': 'Person',
  '@context': 'http://schema.org'
}

/**
 * Redirects the user to the Blockstack browser to approve the sign in request
 * given.
 *
 * The user is redirected to the `blockstackIDHost` if the `blockstack:`
 * protocol handler is not detected. Please note that the protocol handler detection
 * does not work on all browsers.
 * @param  {UserSession} caller - the instance calling this method
 * @param  {String} authRequest - the authentication request generated by `makeAuthRequest`
 * @param  {String} blockstackIDHost - the URL to redirect the user to if the blockstack
 *                                     protocol handler is not detected
 * @return {void}
 * @private
 */
export function redirectToSignInWithAuthRequestImpl(caller: UserSession,
                                                    authRequest: string) {
  const protocolURI = `${BLOCKSTACK_HANDLER}:${authRequest}`

  let httpsURI = `${DEFAULT_BLOCKSTACK_HOST}?authRequest=${authRequest}`

  if (caller.appConfig
      && caller.appConfig.authenticatorURL) {
    httpsURI = `${caller.appConfig.authenticatorURL}?authRequest=${authRequest}`
  }

  // If they're on a mobile OS, always redirect them to HTTPS site
  if (/Android|webOS|iPhone|iPad|iPod|Opera Mini/i.test(navigator.userAgent)) {
    Logger.info('detected mobile OS, sending to https')
    window.location = httpsURI
    return
  }

  function successCallback() {
    Logger.info('protocol handler detected')
    // protocolCheck should open the link for us
  }

  function failCallback() {
    Logger.warn('protocol handler not detected')
    window.location = httpsURI
  }

  function unsupportedBrowserCallback() {
    // Safari is unsupported by protocolCheck
    Logger.warn('can not detect custom protocols on this browser')
    window.location = protocolURI
  }

  protocolCheck(protocolURI, failCallback, successCallback, unsupportedBrowserCallback)
}

/**
 * Generates an authentication request and redirects the user to the Blockstack
 * browser to approve the sign in request.
 *
 * Please note that this requires that the web browser properly handles the
 * `blockstack:` URL protocol handler.
 *
 * Most web applications should use this
 * method for sign in unless they require more fine grained control over how the
 * authentication request is generated. If your app falls into this category,
 * use `makeAuthRequest`,
 * and `redirectToSignInWithAuthRequest` to build your own sign in process.
 * @param {UserSession} caller - the instance calling this function
 * @return {void}
 * @private
 */
export function redirectToSignInImpl(caller: UserSession) {
  const transitKey = caller.generateAndStoreTransitKey()
  const authRequest = caller.makeAuthRequest(transitKey)
  redirectToSignInWithAuthRequestImpl(caller, authRequest)
}


/**
 * Try to process any pending sign in request by returning a `Promise` that resolves
 * to the user data object if the sign in succeeds.
 *
 * @param {UserSession} caller - the instance calling this function
 * @param {String} authResponseToken - the signed authentication response token
 * @return {Promise} that resolves to the user data object if successful and rejects
 * if handling the sign in request fails or there was no pending sign in request.
 * @private
 */
export function handlePendingSignInImpl(caller: UserSession,
                                        authResponseToken: string) {
  const transitKey = caller.store.getSessionData().transitKey

  let coreNode : string = DEFAULT_CORE_NODE

  const coreNodeSessionValue = caller.store.getSessionData().coreNode
  if (coreNodeSessionValue) {
    coreNode = coreNodeSessionValue
  }

  const nameLookupURL = `${coreNode}${NAME_LOOKUP_PATH}`

  return verifyAuthResponse(authResponseToken, nameLookupURL)
    .then((isValid) => {
      if (!isValid) {
        throw new LoginFailedError('Invalid authentication response.')
      }
      const tokenPayload = decodeToken(authResponseToken).payload
      // TODO: real version handling
      let appPrivateKey = tokenPayload.private_key
      let coreSessionToken = tokenPayload.core_token
      if (isLaterVersion(tokenPayload.version, '1.1.0')) {
        if (transitKey !== undefined && transitKey != null) {
          if (tokenPayload.private_key !== undefined && tokenPayload.private_key !== null) {
            try {
              appPrivateKey = decryptPrivateKey(transitKey, tokenPayload.private_key)
            } catch (e) {
              Logger.warn('Failed decryption of appPrivateKey, will try to use as given')
              try {
                hexStringToECPair(tokenPayload.private_key)
              } catch (ecPairError) {
                throw new LoginFailedError('Failed decrypting appPrivateKey. Usually means'
                                         + ' that the transit key has changed during login.')
              }
            }
          }
          if (coreSessionToken !== undefined && coreSessionToken !== null) {
            try {
              coreSessionToken = decryptPrivateKey(transitKey, coreSessionToken)
            } catch (e) {
              Logger.info('Failed decryption of coreSessionToken, will try to use as given')
            }
          }
        } else {
          throw new LoginFailedError('Authenticating with protocol > 1.1.0 requires transit'
                                   + ' key, and none found.')
        }
      }
      let hubUrl = BLOCKSTACK_DEFAULT_GAIA_HUB_URL
      if (isLaterVersion(tokenPayload.version, '1.2.0')
        && tokenPayload.hubUrl !== null && tokenPayload.hubUrl !== undefined) {
        hubUrl = tokenPayload.hubUrl
      }

      const userData = {
        username: tokenPayload.username,
        profile: tokenPayload.profile,
        decentralizedID: tokenPayload.iss,
        identityAddress: getAddressFromDID(tokenPayload.iss),
        appPrivateKey,
        coreSessionToken,
        authResponseToken,
        hubUrl
      }
      const profileURL = tokenPayload.profile_url
      if ((userData.profile === null
         || userData.profile === undefined)
        && profileURL !== undefined && profileURL !== null) {
        return fetch(profileURL)
          .then((response) => {
            if (!response.ok) { // return blank profile if we fail to fetch
              userData.profile = Object.assign({}, DEFAULT_PROFILE)
              const sessionData = caller.store.getSessionData()
              sessionData.userData = userData
              caller.store.setSessionData(sessionData)
              return userData
            } else {
              return response.text()
                .then(responseText => JSON.parse(responseText))
                .then(wrappedProfile => extractProfile(wrappedProfile[0].token))
                .then((profile) => {
                  const sessionData = caller.store.getSessionData()
                  userData.profile = profile
                  sessionData.userData = userData
                  caller.store.setSessionData(sessionData)
                  return userData
                })
            }
          })
      } else {
        const sessionData = caller.store.getSessionData()
        userData.profile = tokenPayload.profile
        sessionData.userData = userData
        caller.store.setSessionData(sessionData)
        return userData
      }
    })
}

/**
 * Retrieves the user data object. The user's profile is stored in the key `profile`.
 *
 *  @param {UserSession} caller - the instance calling this function
 *  @return {Object} User data object.
 *  @private
 */
export function loadUserDataImpl(caller: UserSession) {
  const userData = caller.store.getSessionData().userData
  if (!userData) {
    throw new InvalidStateError('No user data found. Did the user sign in?')
  }
  return userData
}
