package ssh

// InstallMainMirror exposes the install fact New gave the transport.
func InstallMainMirror(s *Server) bool { return s.server.InstallMainMirror }
