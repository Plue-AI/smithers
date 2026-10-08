//! Skeleton dispatcher; default hooks answer unsupported without side effects.
use crate::{
    conn::{self, Frame, ProtocolError},
    hooks::Hooks,
    lock::LockCx,
};
pub fn dispatch(frame: &Frame, cx: &mut LockCx) -> Result<Frame, ProtocolError> {
    frame.encode()?;
    if (frame.kind == 4 || frame.kind == 5) && cx.rewrite_pending {
        return Ok(Frame {
            kind: frame.kind,
            stream: frame.stream,
            payload: conn::tagged(255, &crate::freeze::pending_error().fields()),
        });
    }
    if frame.kind == 4 {
        let hook = match crate::document_payload::Document::decode_v2(&frame.payload) {
            Ok(document) if matches!(document.msg, 1 | 2) => cx.hooks.documents.frame(frame),
            _ => Err(crate::hooks::Error::unsupported()),
        };
        return Ok(hook.unwrap_or_else(|e| Frame {
            kind: frame.kind,
            stream: frame.stream,
            payload: conn::tagged(255, &e.fields()),
        }));
    }
    let (id, method, args) = frame.request()?;
    let hooks: Hooks = cx.hooks.clone();
    // wake_reconcile is the owner's recovery entry; ordinary mutations remain
    // barred until its native checkpoint or committed settlement finishes.
    let result = if cx.rewrite_pending && !matches!(method, 1 | 2 | 5 | 8 | 9 | 14 | 16) {
        Err(crate::freeze::pending_error())
    } else {
        match method {
            11 => {
                let (onto, actor) = conn::rebase_args(args)?;
                hooks.core.validate_rebase(onto).and_then(|()| {
                    hooks.events.rebase_started(onto, id);
                    let result = crate::freeze::freeze_then(cx, &actor, |cx| {
                        let head = hooks.core.rebase(cx, onto)?;
                        let mut fields = vec![conn::field(1, head)];
                        if let Some(paths) = hooks.core.rebase_paths(head)? {
                            fields.push(conn::field(2, crate::reconcile::paths_payload(&paths)?));
                        }
                        Ok(conn::structure_bytes(&fields))
                    });
                    hooks.events.rebase_finished(result.is_err());
                    result
                })
            }

            // Inspection has its own admitted call; status remains observational.
            18 => hooks.core.call(cx, method, args),

            12 => {
                let actor = conn::return_to_item_actor(args)?;
                crate::wiring::ready(&hooks)
                    .map_err(|error| match error {
                        crate::wiring::StartError::NotReady { source, .. } => source,
                        crate::wiring::StartError::Executor(_) => {
                            crate::hooks::Error::unsupported()
                        }
                    })
                    .and_then(|()| hooks.core.validate_return_to_item())
                    .and_then(|()| {
                        crate::freeze::freeze_return(cx, &actor, |cx| hooks.core.return_to_item(cx))
                            .map(|head| conn::structure_bytes(&[conn::field(1, head)]))
                    })
            }

            13 => {
                let (path, actor) = conn::open_doc_args(args)?;
                match actor {
                    Some(actor) => hooks.documents.open_authenticated(&path, &actor),
                    None => Err(crate::hooks::Error::unsupported()),
                }
                .map(|s| conn::structure_bytes(&[conn::field(1, s.to_be_bytes())]))
            }
            14 => hooks
                .documents
                .close(u32::from_be_bytes(args[5..9].try_into().unwrap()))
                .map(|()| conn::structure_bytes(&[])),
            6..=10 | 15 => hooks.sessions.call(method, args),
            16 => hooks
                .broker
                .set_roster(&conn::roster_args(args)?)
                .map(|()| conn::structure_bytes(&[])),
            _ => hooks.core.call(cx, method, args),
        }
    };
    let value = match result {
        Ok(body) => {
            let mut b = vec![method];
            b.extend(body);
            b
        }
        Err(e) => conn::tagged(255, &e.fields()),
    };
    Ok(Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            2,
            &[conn::field(1, id.to_be_bytes()), conn::field(2, value)],
        ),
    })
}
/// Streaming controls need not produce a receipt. In particular a window must
/// not be echoed, and blocked stdin earns credit only after kernel delivery.
pub fn dispatch_input(frame: &Frame, cx: &mut LockCx) -> Result<Option<Frame>, ProtocolError> {
    if frame.kind != 5 {
        return dispatch(frame, cx).map(Some);
    }
    frame.encode()?;
    let result = if cx.rewrite_pending {
        Err(crate::freeze::pending_error())
    } else {
        cx.hooks.sessions.frame(frame)
    };
    Ok(result.unwrap_or_else(|error| {
        Some(Frame {
            kind: 5,
            stream: frame.stream,
            payload: conn::tagged(255, &error.fields()),
        })
    }))
}
pub fn serve_one(
    reader: &mut impl std::io::Read,
    writer: &mut impl std::io::Write,
    cx: &mut LockCx,
) -> Result<(), ProtocolError> {
    let frame = Frame::read_envelope(reader)?;
    let response = match frame.validate(false) {
        Ok(()) => dispatch_input(&frame, cx)?,
        Err(e) => Some(malformed_response(&frame, e)?),
    };
    if let Some(response) = response {
        response
            .write(writer)
            .map_err(|_| ProtocolError::Truncated)?;
    }
    Ok(())
}
/// Return a correlated refusal only when the request id was safely decoded.
pub fn malformed_response(frame: &Frame, e: ProtocolError) -> Result<Frame, ProtocolError> {
    if (5..=12).contains(&(e as u8))
        && frame.kind == 1
        && frame.payload.len() >= 10
        && frame.payload[0] == 1
        && frame.payload[5] == 1
    {
        let id = u32::from_be_bytes(frame.payload[6..10].try_into().unwrap());
        Ok(crate::daemon::refused(
            id,
            crate::hooks::Error {
                code: 1,
                protocol: Some(e),
                ..crate::hooks::Error::unsupported()
            },
        ))
    } else {
        Err(e)
    }
}
